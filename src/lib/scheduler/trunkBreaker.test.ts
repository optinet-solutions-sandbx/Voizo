import { describe, it, expect } from "vitest";
import {
  assessTrunkHealth,
  selectProbeParent,
  TRUNK_MIN_DIALS,
  type ParentProbeCandidate,
} from "./trunkBreaker";

describe("assessTrunkHealth", () => {
  it("REFUSING when dials happened and nothing connected (08-11 real shape)", () => {
    expect(assessTrunkHealth({ dials: 107, connected: 0 })).toBe("REFUSING");
  });

  it("HEALTHY on a normal day (08-01 real shape)", () => {
    expect(assessTrunkHealth({ dials: 2828, connected: 2344 })).toBe("HEALTHY");
  });

  it("HEALTHY on a SINGLE connect — one success proves the trunk passes calls", () => {
    expect(assessTrunkHealth({ dials: 500, connected: 1 })).toBe("HEALTHY");
  });

  // FAIL-OPEN LOCKS. Too little evidence must never read as REFUSING, or a quiet
  // night would hold the next day's spawns and the gate becomes the outage.
  it("UNKNOWN below the evidence floor", () => {
    expect(assessTrunkHealth({ dials: TRUNK_MIN_DIALS - 1, connected: 0 })).toBe("UNKNOWN");
  });

  it("UNKNOWN when nothing was dialled at all (quiet != broken)", () => {
    expect(assessTrunkHealth({ dials: 0, connected: 0 })).toBe("UNKNOWN");
  });

  it("REFUSING exactly AT the floor — boundary is inclusive", () => {
    expect(assessTrunkHealth({ dials: TRUNK_MIN_DIALS, connected: 0 })).toBe("REFUSING");
  });

  it("honours a caller-supplied floor", () => {
    expect(assessTrunkHealth({ dials: 50, connected: 0 }, 100)).toBe("UNKNOWN");
  });
});

describe("selectProbeParent", () => {
  const c = (id: string, newestChildStartAt: string | null): ParentProbeCandidate => ({
    id,
    newestChildStartAt,
  });

  it("returns null for an empty list rather than throwing", () => {
    expect(selectProbeParent([])).toBeNull();
  });

  it("picks the parent whose most recent child is oldest", () => {
    expect(
      selectProbeParent([
        c("a", "2026-08-11T00:00:00Z"),
        c("b", "2026-08-08T00:00:00Z"),
        c("c", "2026-08-10T00:00:00Z"),
      ]),
    ).toBe("b");
  });

  it("a parent that has NEVER spawned sorts first — most overdue, not last", () => {
    expect(selectProbeParent([c("a", "2026-08-11T00:00:00Z"), c("b", null)])).toBe("b");
  });

  it("breaks ties by id so the choice is deterministic across ticks", () => {
    const all = "2026-08-11T00:00:00Z";
    expect(selectProbeParent([c("z", all), c("a", all), c("m", all)])).toBe("a");
  });

  // ── 2026-08-12 REGRESSION LOCKS ──
  // The pick ranks by newestChildStartAt. Ranking is only stable if a spawn cannot
  // change that value, which is why the caller must supply the newest child from
  // BEFORE today. These two tests pin both halves of that argument.
  it("STABLE across many ticks in one day: pre-today keys don't move, so the pick doesn't", () => {
    // Yesterday's children. A spawn today cannot alter any of these values.
    const preToday = [
      c("19ea5cb7", "2026-08-11T00:00:00Z"),
      c("45ff7dd9", "2026-08-11T00:00:00Z"),
      c("80f19103", "2026-08-11T00:00:00Z"),
      c("dbcb0f64", "2026-08-11T00:00:00Z"),
    ];
    const picks = Array.from({ length: 5 }, () => selectProbeParent(preToday));
    expect(new Set(picks).size).toBe(1);
    expect(picks[0]).toBe("19ea5cb7");
  });

  it("COUNTER-EXAMPLE (why the caller must exclude today): each spawn moves the winner", () => {
    // Replays prod on 2026-08-12. Feeding today's child back in makes every tick
    // pick a DIFFERENT parent, so all four spawn: 1,660 dials instead of ~15-20.
    const newest: Record<string, string | null> = {
      "19ea5cb7": "2026-08-11T00:00:00Z",
      "45ff7dd9": "2026-08-11T00:00:00Z",
      "80f19103": "2026-08-11T00:00:00Z",
      dbcb0f64: "2026-08-11T00:00:00Z",
    };
    const picks: string[] = [];
    for (let tick = 0; tick < 4; tick++) {
      const pick = selectProbeParent(Object.entries(newest).map(([id, t]) => c(id, t)));
      if (!pick) throw new Error("expected a pick");
      picks.push(pick);
      newest[pick] = "2026-08-12T00:00:00Z"; // the CONTRACT VIOLATION: today's child
    }
    // Observed prod spawn order, to the second: 22:31:20 / 22:31:59 / 22:32:38 / 22:33:23.
    expect(picks).toEqual(["19ea5cb7", "45ff7dd9", "80f19103", "dbcb0f64"]);
  });

  it("ROTATES: four parents each probe once across four consecutive days", () => {
    const newest: Record<string, string | null> = { a: null, b: null, c: null, d: null };
    const chosen: string[] = [];
    for (let day = 1; day <= 4; day++) {
      const pick = selectProbeParent(Object.entries(newest).map(([id, t]) => c(id, t)));
      if (!pick) throw new Error("expected a probe parent");
      chosen.push(pick);
      newest[pick] = `2026-08-0${day}T00:00:00Z`; // this parent just spawned
    }
    expect(chosen).toEqual(["a", "b", "c", "d"]);
    expect(new Set(chosen).size).toBe(4); // nobody probes twice before everyone has
  });

  it("does not mutate the caller's array", () => {
    const input = [c("z", "2026-08-11T00:00:00Z"), c("a", "2026-08-08T00:00:00Z")];
    const before = input.map((x) => x.id);
    selectProbeParent(input);
    expect(input.map((x) => x.id)).toEqual(before);
  });
});

// The slot-release predicate that briefly lived here was DELETED 2026-08-12 along
// with the write it guarded — removing the mutation beat making it safe. Nothing in
// this module writes, so there is nothing left to test on that path.
