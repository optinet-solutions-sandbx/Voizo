// trunkGateData.test.ts — VOZ-371. The gate's WIRING, not its arithmetic.
//
// assessTrunkHealth + selectProbeParent already have 13 passing tests, and both
// were CORRECT when the 2026-08-12 outage shipped. The bug was in the queries
// feeding them, so this suite drives resolveTrunkGate against a fake that
// RECORDS every builder call — the only vantage point from which a missing
// `.lt("start_at", dayStart)` or `.not("provider_call_id", ...)` is visible.
//
// Each of the two historical defects has a named guard below; both were verified
// to FAIL when the corresponding filter is removed from trunkGateData.ts.
import { describe, expect, it } from "vitest";
import {
  resolveTrunkGate,
  type GateBuilder,
  type GateCountResult,
  type GateDb,
  type GateLog,
  type GateRowResult,
} from "./trunkGateData";
import { TRUNK_MIN_DIALS, TRUNK_WINDOW_HOURS } from "./trunkBreaker";

const SYD = "Australia/Sydney";
interface Op { method: string; args: unknown[] }
interface Chain { table: string; ops: Op[] }

/** Chainable, recording, read-only Supabase stand-in. Routes the two count
 *  queries by the filter that distinguishes them (an eq on hangup_cause = the
 *  connected count), so a MISSING provider_call_id filter still lands in the
 *  dials slot and is caught by an explicit shape assertion rather than by a
 *  confusing mis-route. */
function makeDb(cfg: {
  dials?: GateCountResult;
  connected?: GateCountResult;
  child?: (parentId: string) => GateRowResult;
}): { db: GateDb; chains: Chain[] } {
  const chains: Chain[] = [];
  const from = (table: string): GateBuilder => {
    const chain: Chain = { table, ops: [] };
    chains.push(chain);
    const has = (method: string, col: string) =>
      chain.ops.some((o) => o.method === method && o.args[0] === col);
    const builder = {
      maybeSingle: () => {
        const pid = String(
          chain.ops.find((o) => o.method === "eq" && o.args[0] === "parent_campaign_id")?.args[1] ?? "",
        );
        return Promise.resolve(cfg.child ? cfg.child(pid) : { data: null, error: null });
      },
      then: (onFulfilled?: (v: GateCountResult) => unknown, onRejected?: (e: unknown) => unknown) => {
        const res = has("eq", "hangup_cause")
          ? (cfg.connected ?? { count: 0, error: null })
          : (cfg.dials ?? { count: 0, error: null });
        return Promise.resolve(res).then(onFulfilled, onRejected);
      },
    } as unknown as GateBuilder;
    for (const m of ["select", "eq", "neq", "gt", "gte", "lt", "not", "order", "limit"] as const) {
      (builder as unknown as Record<string, unknown>)[m] = (...args: unknown[]) => {
        chain.ops.push({ method: m, args });
        return builder;
      };
    }
    return builder;
  };
  return { db: { from }, chains };
}

const quietLog = (): GateLog & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
};

const P = (id: string, timezone: string | null = SYD) => ({ id, timezone });
const FOUR = [P("A"), P("B"), P("C"), P("D")];
/** A refusing trunk: enough dials to be trustworthy, zero connects. */
const REFUSING = { dials: { count: TRUNK_MIN_DIALS + 100, error: null }, connected: { count: 0, error: null } };
const chainOn = (chains: Chain[], table: string) => chains.filter((c) => c.table === table);
const arg = (c: Chain, method: string, col: string) =>
  c.ops.find((o) => o.method === method && o.args[0] === col)?.args;

describe("resolveTrunkGate — verdict", () => {
  it("HEALTHY on any connect, and asks for NO child rows (yesterday's connects still count)", async () => {
    const { db, chains } = makeDb({ dials: { count: 759, error: null }, connected: { count: 678, error: null } });
    const log = quietLog();
    const r = await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), log);
    expect(r).toEqual({ health: "HEALTHY", probeParentId: null });
    // The 2026-08-14 shape: a healthy trunk gates nothing, so all four spawn in
    // one burst. Cheap too — zero campaigns_v2 reads.
    expect(chainOn(chains, "campaigns_v2")).toHaveLength(0);
    expect(log.lines.join("\n")).toContain("HEALTHY — 678 connected of 759 dials");
  });

  it("UNKNOWN (fail open) below the evidence floor", async () => {
    const { db } = makeDb({ dials: { count: TRUNK_MIN_DIALS - 1, error: null }, connected: { count: 0, error: null } });
    const r = await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), quietLog());
    expect(r).toEqual({ health: "UNKNOWN", probeParentId: null });
  });

  it("REFUSING picks exactly one probe parent", async () => {
    const { db } = makeDb({ ...REFUSING, child: () => ({ data: null, error: null }) });
    const r = await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), quietLog());
    expect(r.health).toBe("REFUSING");
    expect(r.probeParentId).not.toBeNull();
  });
});

describe("resolveTrunkGate — the 2026-08-12 defect class", () => {
  // Pre-today children, oldest-first: D is the most overdue prober.
  const KEYS: Record<string, string> = {
    A: "2026-08-10T22:30:00Z",
    B: "2026-08-11T22:30:00Z",
    C: "2026-08-12T22:30:00Z",
    D: "2026-08-09T22:30:00Z",
  };
  const childFrom = (keys: Record<string, string>) => (pid: string) =>
    ({ data: keys[pid] ? { start_at: keys[pid] } : null, error: null });

  it("probe pick is STABLE across many ticks of the same day", async () => {
    const picks = new Set<string | null>();
    // Ticks a minute apart — the 08-12 bug produced a DIFFERENT winner each tick,
    // so every parent spawned in turn (4 spawns, 2,027 dials, none connecting).
    for (const min of ["31", "32", "33", "45", "59"]) {
      const { db } = makeDb({ ...REFUSING, child: childFrom(KEYS) });
      const r = await resolveTrunkGate(db, FOUR, new Date(`2026-08-13T22:${min}:00Z`), quietLog());
      picks.add(r.probeParentId);
    }
    expect(picks.size).toBe(1);
    expect([...picks][0]).toBe("D");
  });

  it("…and ROTATES the next day, once the prober owns the newest child", async () => {
    // D probed on 08-13, so on 08-14 its newest PRE-TODAY child is that spawn —
    // no longer the most overdue. A (08-10) inherits the slot.
    const { db } = makeDb({
      ...REFUSING,
      child: childFrom({ ...KEYS, D: "2026-08-13T22:30:00Z" }),
    });
    const r = await resolveTrunkGate(db, FOUR, new Date("2026-08-14T22:31:00Z"), quietLog());
    expect(r.probeParentId).toBe("A");
  });

  it("GUARD (VOZ-368): the newest-child query EXCLUDES today, in the parent's own timezone", async () => {
    const { db, chains } = makeDb({ ...REFUSING, child: childFrom(KEYS) });
    // 2026-08-13T22:31Z = 2026-08-14 08:31 Sydney ⇒ that day began 2026-08-13T14:00Z.
    await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), quietLog());
    const kids = chainOn(chains, "campaigns_v2");
    expect(kids).toHaveLength(4); // one limit(1) lookup per parent, never a pooled .in()
    for (const c of kids) {
      // Omitting this lt() IS the outage: it makes the ranking key mutable, so a
      // spawn changes its own sort order.
      expect(arg(c, "lt", "start_at"), "start_at upper bound missing").toEqual([
        "start_at",
        "2026-08-13T14:00:00.000Z",
      ]);
      expect(arg(c, "neq", "status")).toEqual(["status", "skipped"]);
      expect(arg(c, "order", "start_at")).toEqual(["start_at", { ascending: false }]);
      expect(c.ops.some((o) => o.method === "limit" && o.args[0] === 1)).toBe(true);
    }
    expect(kids.map((c) => arg(c, "eq", "parent_campaign_id")?.[1])).toEqual(["A", "B", "C", "D"]);
  });

  it("GUARD (VOZ-372): only trunk-REACHED dials count as trunk evidence", async () => {
    const { db, chains } = makeDb({ ...REFUSING, child: childFrom(KEYS) });
    const now = new Date("2026-08-13T22:31:00Z");
    await resolveTrunkGate(db, FOUR, now, quietLog());
    const calls = chainOn(chains, "calls_v2");
    expect(calls).toHaveLength(2);
    const connected = calls.find((c) => arg(c, "eq", "hangup_cause"))!;
    const dials = calls.find((c) => c !== connected)!;
    // Without this filter, 2,027 dials that died before FreeSWITCH pinned the
    // verdict at REFUSING instead of failing open.
    expect(arg(dials, "not", "provider_call_id"), "provider_call_id filter missing")
      .toEqual(["provider_call_id", "is", null]);
    // duration_seconds > 0 is load-bearing: 08-06 had 147 NORMAL_CLEARING rows
    // but only 88 with audio.
    expect(arg(connected, "eq", "hangup_cause")).toEqual(["hangup_cause", "NORMAL_CLEARING"]);
    expect(arg(connected, "gt", "duration_seconds")).toEqual(["duration_seconds", 0]);
    // 26h window, measured from the injected clock — must span past yesterday's
    // dialling or the gate reads a quiet night as a dead trunk.
    const since = new Date(now.getTime() - TRUNK_WINDOW_HOURS * 3_600_000).toISOString();
    for (const c of calls) expect(arg(c, "gte", "created_at")).toEqual(["created_at", since]);
  });
});

describe("resolveTrunkGate — fails OPEN on every error path", () => {
  it("count query error ⇒ UNKNOWN, and no child rows are read", async () => {
    const { db, chains } = makeDb({
      dials: { count: null, error: { message: "boom" } },
      connected: { count: 0, error: null },
    });
    const log = quietLog();
    const r = await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), log);
    expect(r).toEqual({ health: "UNKNOWN", probeParentId: null });
    expect(chainOn(chains, "campaigns_v2")).toHaveLength(0);
    expect(log.lines.join("\n")).toContain("FAILING OPEN");
  });

  it("a parent with no timezone ⇒ UNKNOWN (never a thrown RangeError that kills the tick)", async () => {
    const { db } = makeDb({ ...REFUSING, child: () => ({ data: null, error: null }) });
    const log = quietLog();
    const r = await resolveTrunkGate(db, [P("A"), P("B", null), P("C")], new Date("2026-08-13T22:31:00Z"), log);
    expect(r).toEqual({ health: "UNKNOWN", probeParentId: null });
    expect(log.lines.join("\n")).toContain("parent B has no timezone");
  });

  it("child lookup error ⇒ UNKNOWN", async () => {
    const { db } = makeDb({
      ...REFUSING,
      child: (pid) => (pid === "B" ? { data: null, error: { message: "nope" } } : { data: null, error: null }),
    });
    const r = await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), quietLog());
    expect(r).toEqual({ health: "UNKNOWN", probeParentId: null });
  });

  it("no parents ⇒ REFUSING with no probe (nothing to spawn, nothing to hold)", async () => {
    const { db } = makeDb({ ...REFUSING });
    const r = await resolveTrunkGate(db, [], new Date("2026-08-13T22:31:00Z"), quietLog());
    expect(r).toEqual({ health: "REFUSING", probeParentId: null });
  });
});

describe("resolveTrunkGate — the count window's inherited asymmetry", () => {
  it("bounds only the LOWER edge, so a past `now` does not replay that moment", () => {
    // Inherited verbatim from the route. Discovered 2026-08-14 while verifying the
    // extraction against live prod: now=2026-08-11T22:31Z returned HEALTHY, because
    // the counts ran through to the real present; the same window with an upper
    // bound is 107 dials / 0 connects = REFUSING.
    //
    // If you add `.lt("created_at", now)` — which would also give the two parallel
    // counts one shared upper edge — this test SHOULD fail. Change it deliberately.
    const { db, chains } = makeDb({ dials: { count: 10, error: null }, connected: { count: 1, error: null } });
    return resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), quietLog()).then(() => {
      for (const c of chainOn(chains, "calls_v2")) {
        expect(arg(c, "gte", "created_at")).toBeDefined();
        expect(arg(c, "lt", "created_at"), "an upper bound appeared — see the comment").toBeUndefined();
      }
    });
  });
});

describe("resolveTrunkGate — READ-ONLY by contract", () => {
  it("touches only calls_v2 + campaigns_v2, and only with read verbs", async () => {
    // 2026-08-12: the skip path released the prior child's SIP slot, stripping a
    // just-spawned child's assistant + SIP URI and latching the dialer at zero
    // calls. The gate must only ever DECIDE. (The interface exposes no mutating
    // verb; this is the runtime backstop against a future cast around it.)
    const { db, chains } = makeDb({ ...REFUSING, child: () => ({ data: null, error: null }) });
    await resolveTrunkGate(db, FOUR, new Date("2026-08-13T22:31:00Z"), quietLog());
    const READ_VERBS = new Set(["select", "eq", "neq", "gt", "gte", "lt", "not", "order", "limit"]);
    expect(new Set(chains.map((c) => c.table))).toEqual(new Set(["calls_v2", "campaigns_v2"]));
    for (const c of chains) {
      for (const o of c.ops) expect(READ_VERBS.has(o.method), `${c.table}.${o.method}`).toBe(true);
    }
  });
});
