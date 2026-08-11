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
