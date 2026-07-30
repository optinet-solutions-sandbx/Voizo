import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  decideAdmission,
  diffNewMembers,
  duePromotions,
  expectedCountryForTimezone,
  partitionRollover,
  pollRealtimeParent,
  rolloverLeftovers,
} from "./realtimePoll";
import { fetchAllRows } from "../supabaseFetchAll";

// ── Mocks for the pollRealtimeParent workspace-threading test (VOZ-198) ────
// Everything else in this file tests pure functions and touches none of these.
const pm = vi.hoisted(() => ({
  getSegmentMembers: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock("../customerio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../customerio")>();
  return {
    ...actual,
    getSegmentMembers: pm.getSegmentMembers,
    lookupMemberProfileWithFallback: pm.lookup,
  };
});
vi.mock("../supabaseFetchAll", () => ({ fetchAllRows: vi.fn(async () => []) }));
vi.mock("../alerts/slack", () => ({
  postSlackAlert: vi.fn(async () => {}),
  shouldAlertSpawnFail: vi.fn(() => false),
}));
vi.mock("./realtimeAdmission", () => ({
  findTodaysChild: vi.fn(async () => ({ ok: true, child: { id: "child-1", name: "FP child", daily_cap: null } })),
  claimAndQueueMember: vi.fn(async () => ({ won: true, queued: true })),
  promoteWaitingMember: vi.fn(async () => "promoted"),
}));

describe("expectedCountryForTimezone", () => {
  it("maps the three launch regions", () => {
    expect(expectedCountryForTimezone("Australia/Sydney")).toBe("AU");
    expect(expectedCountryForTimezone("Pacific/Auckland")).toBe("NZ");
    // +1 bucket: US/CA share a prefix — indistinguishable, known limit.
    expect(expectedCountryForTimezone("America/Toronto")).toBe("NA");
  });

  it("returns null for unmapped timezones (no constraint)", () => {
    expect(expectedCountryForTimezone("UTC")).toBeNull();
    expect(expectedCountryForTimezone("")).toBeNull();
    expect(expectedCountryForTimezone("Mars/Olympus_Mons")).toBeNull();
  });
});

describe("decideAdmission", () => {
  const base = { expectedCountry: "AU", addedToday: 0, dailyCap: 100 };

  it("admits a matching-country phone, normalized", () => {
    expect(decideAdmission({ ...base, rawPhone: "+61 412 345 678" })).toEqual({
      admit: true,
      phone: "+61412345678",
    });
  });

  it("rejects a wrong-country phone as rejected_country", () => {
    expect(decideAdmission({ ...base, rawPhone: "+14165550123" })).toEqual({
      admit: false,
      claimStatus: "rejected_country",
      phone: "+14165550123",
    });
  });

  it("admits any country when expectedCountry is null", () => {
    expect(
      decideAdmission({ ...base, expectedCountry: null, rawPhone: "+14165550123" }),
    ).toEqual({ admit: true, phone: "+14165550123" });
  });

  it("claims no_phone for a missing/blank phone", () => {
    expect(decideAdmission({ ...base, rawPhone: null })).toEqual({
      admit: false,
      claimStatus: "no_phone",
      phone: null,
    });
    expect(decideAdmission({ ...base, rawPhone: "   " })).toEqual({
      admit: false,
      claimStatus: "no_phone",
      phone: null,
    });
  });

  it("claims invalid_phone for an unnormalizable phone", () => {
    expect(decideAdmission({ ...base, rawPhone: "not-a-phone" })).toEqual({
      admit: false,
      claimStatus: "invalid_phone",
      phone: null,
    });
  });

  it("cap-blocks WITHOUT claiming (retryable on a later day)", () => {
    expect(
      decideAdmission({ ...base, addedToday: 100, rawPhone: "+61412345678" }),
    ).toEqual({ admit: false, capBlocked: true });
  });

  it("null cap = uncapped", () => {
    expect(
      decideAdmission({ ...base, dailyCap: null, addedToday: 9999, rawPhone: "+61412345678" })
        .admit,
    ).toBe(true);
  });

  it("cap check runs BEFORE phone/country work (a capped day claims nothing)", () => {
    expect(decideAdmission({ ...base, addedToday: 100, rawPhone: null })).toEqual({
      admit: false,
      capBlocked: true,
    });
  });
});

describe("diffNewMembers", () => {
  it("returns only unseen ids, preserving order, deduped", () => {
    expect(diffNewMembers(["a", "b", "a", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("empty inputs", () => {
    expect(diffNewMembers([], new Set())).toEqual([]);
    expect(diffNewMembers([], new Set(["x"]))).toEqual([]);
  });

  it("all seen → empty", () => {
    expect(diffNewMembers(["a", "b"], new Set(["a", "b"]))).toEqual([]);
  });
});

describe("partitionRollover", () => {
  it("carries pending + pending_retry with attempt_count preserved; closes exactly those rows", () => {
    const rows = [
      // display_name carries across days (greet-by-name Ramp 1) — a player must
      // not lose their name when their number rolls into the next child.
      { id: "1", phone_e164: "+61400000001", attempt_count: 0, outcome: "pending", display_name: "Vicky Seavers" },
      { id: "2", phone_e164: "+61400000002", attempt_count: 2, outcome: "pending_retry", display_name: null },
      { id: "3", phone_e164: "+61400000003", attempt_count: 1, outcome: "sent_sms", display_name: "Dropped Terminal" },
      { id: "4", phone_e164: "+61400000004", attempt_count: null, outcome: "pending" },
      { id: "5", phone_e164: "+61400000005", attempt_count: 3, outcome: "unreached", display_name: null },
    ];
    const { carry, closeIds } = partitionRollover(rows);
    expect(carry).toEqual([
      { phone_e164: "+61400000001", attempt_count: 0, display_name: "Vicky Seavers" },
      { phone_e164: "+61400000002", attempt_count: 2, display_name: null },
      { phone_e164: "+61400000004", attempt_count: 0, display_name: null },
    ]);
    expect(closeIds).toEqual(["1", "2", "4"]);
  });

  it("nothing open → nothing carried", () => {
    expect(
      partitionRollover([{ id: "1", phone_e164: "+61400000001", attempt_count: 1, outcome: "sent_sms" }]),
    ).toEqual({ carry: [], closeIds: [] });
    expect(partitionRollover([])).toEqual({ carry: [], closeIds: [] });
  });
});

describe("duePromotions", () => {
  const NOW = new Date("2026-07-13T10:00:00Z");
  const row = (id: string, minsAgo: number) => ({
    cio_id: id,
    phone_e164: "+61400000000",
    first_seen_at: new Date(NOW.getTime() - minsAgo * 60_000).toISOString(),
  });

  it("due only when first_seen + delay has passed", () => {
    const rows = [row("a", 31), row("b", 29)];
    expect(duePromotions(rows, 30, NOW, 10).map((r) => r.cio_id)).toEqual(["a"]);
  });

  it("null delay = everything waiting is due (delay cleared mid-flight)", () => {
    expect(duePromotions([row("a", 0), row("b", 500)], null, NOW, 10)).toHaveLength(2);
  });

  it("oldest first, sliced to cap room", () => {
    const rows = [row("young", 40), row("old", 90), row("mid", 60)];
    expect(duePromotions(rows, 30, NOW, 2).map((r) => r.cio_id)).toEqual(["old", "mid"]);
  });

  it("no room = nothing promotes", () => {
    expect(duePromotions([row("a", 90)], 30, NOW, 0)).toEqual([]);
  });

  it("cutoff is inclusive: a member seen EXACTLY delay-minutes ago is due", () => {
    // first_seen + delay == now → getTime() <= cutoff, so it promotes. Pins the
    // <= boundary against an off-by-one that would hold a fully-served signup.
    expect(duePromotions([row("edge", 30)], 30, NOW, 10).map((r) => r.cio_id)).toEqual(["edge"]);
  });

  it("delay of 0 promotes immediately (cutoff = now, distinct input from null)", () => {
    // call_delay_minutes can be 0 (routes through the promotion pass, unlike
    // null which queues directly); a 0-minute delay is served on the next tick.
    expect(duePromotions([row("a", 0), row("b", 1)], 0, NOW, 10)).toHaveLength(2);
  });

  it("negative room promotes nothing (room = cap - addedToday after a soft overshoot)", () => {
    // A soft-cap breach (see decideAdmission suite) leaves addedToday > cap, so
    // room goes negative; the guard must reject it, not slice(0, -n) the queue.
    expect(duePromotions([row("a", 90), row("b", 91)], 30, NOW, -5)).toEqual([]);
  });
});

describe("decideAdmission — daily cap boundary + overlap semantics", () => {
  const valid = (addedToday: number, dailyCap: number | null) =>
    decideAdmission({ rawPhone: "+61412345678", expectedCountry: "AU", addedToday, dailyCap });

  it("admits at cap-1, blocks exactly at cap (>= boundary)", () => {
    expect(valid(99, 100).admit).toBe(true);
    expect(valid(100, 100)).toEqual({ admit: false, capBlocked: true });
  });

  it("dailyCap of 0 blocks the very first member", () => {
    expect(valid(0, 0)).toEqual({ admit: false, capBlocked: true });
  });

  it("blocks when already over cap (addedToday > cap)", () => {
    expect(valid(150, 100)).toEqual({ admit: false, capBlocked: true });
  });

  // The two invariants the supervised real-money trial hinges on. Mirrors
  // pollRealtimeParent step 6: one addedToday SNAPSHOT per tick, then a loop
  // that feeds each decision the running total (addedToday + admitted).
  const runTick = (startCount: number, cap: number, candidates: number): number => {
    let admitted = 0;
    for (let i = 0; i < candidates; i++) {
      const d = decideAdmission({
        rawPhone: "+61412345678",
        expectedCountry: "AU",
        addedToday: startCount + admitted, // running total, exactly as the loop does
        dailyCap: cap,
      });
      if ("capBlocked" in d) break;
      if (d.admit) admitted++;
    }
    return admitted;
  };

  it("cap is HARD within a single tick (running total is respected, never overshoots)", () => {
    expect(runTick(90, 100, 50)).toBe(10); // 90 in, 10 room, 50 eager → exactly 10
    expect(runTick(0, 100, 250)).toBe(100); // stops dead at the cap
  });

  it("cap is SOFT across overlapping ticks (known limit — stateless, snapshot per tick)", () => {
    // Two ticks fire before either commits, so BOTH read the same stale count.
    const snapshot = 90;
    const cap = 100;
    const tickA = runTick(snapshot, cap, 50);
    const tickB = runTick(snapshot, cap, 50); // same snapshot → overlap
    expect(tickA).toBe(10);
    expect(tickB).toBe(10);
    // Combined the child lands at 110 — 10 over cap. This pins the documented
    // "cap is soft under overlapping ticks" behavior: decideAdmission keeps no
    // cross-call memory, so a future change that assumes a hard cap trips here.
    expect(snapshot + tickA + tickB).toBe(110);
    expect(snapshot + tickA + tickB).toBeGreaterThan(cap);
  });
});

// VOZ-198: a Fortune Play (workspace #2) parent must poll ITS workspace's
// segment and look profiles up with ITS key — the single-key era silently
// queried Lucky7 for every parent (cross-brand read / dead safety net).
describe("pollRealtimeParent threads the parent's cio_workspace into every CIO call (VOZ-198)", () => {
  function fakeDb(responses: Array<{ data?: unknown; error?: unknown; count?: number }>) {
    const queue = [...responses];
    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => void) {
        const next = queue.shift() ?? { data: null, error: null };
        resolve({ data: next.data ?? null, error: next.error ?? null, count: next.count ?? 0 });
      },
    };
    for (const m of ["select", "eq", "in", "gte", "lt", "limit", "order", "maybeSingle", "upsert", "insert", "update"]) {
      chain[m] = () => chain;
    }
    return { from: () => chain } as never;
  }

  it("passes cio_workspace to getSegmentMembers and lookupMemberProfileWithFallback", async () => {
    pm.getSegmentMembers.mockResolvedValue({
      success: true,
      data: { identifiers: [{ cio_id: "m1" }], next: null },
      error: null,
    });
    pm.lookup.mockResolvedValue({
      success: true,
      data: { id: "m1", email: null, attributes: { phone: "+61412345678", first_name: "Jo" } },
      error: null,
    });

    const parent = {
      id: "parent-fp",
      name: "RT FP AU",
      timezone: "Australia/Sydney",
      segment_id: 406,
      call_delay_minutes: null,
      cio_workspace: "fortuneplay",
    };
    const summary = await pollRealtimeParent(
      fakeDb([{ count: 0 }, { data: [] }]), // addedToday count, waiting rows
      parent,
      new Date("2026-07-24T03:00:00Z"),
    );

    expect(summary.result).toBe("polled");
    expect(pm.getSegmentMembers).toHaveBeenCalled();
    expect(pm.getSegmentMembers.mock.calls[0][2]).toBe("fortuneplay");
    expect(pm.lookup).toHaveBeenCalled();
    expect(pm.lookup.mock.calls[0][1]).toBe("fortuneplay");
  });
});

// ── rolloverLeftovers — the 1000-row clamp (VOZ-264's scheduler sibling) ───
//
// PostgREST max-rows clamps EVERY read at 1000 rows. Measured 2026-07-30 on the
// CA reactivation child: 1,820 open rows, the unpaged leftover query returned
// 1,000, and 820 players were silently stranded — the realtime poll re-admits
// nobody (every segment member is already seen/queued) and the next day's
// rollover reads only the MOST RECENT prior child, so a stranded row is never
// examined again. These tests drive rolloverLeftovers against a mock client
// that SIMULATES the clamp (never more than 1000 rows per request), with the
// real fetchAllRows implementation restored over the module mock.
describe("rolloverLeftovers — paginates past the 1000-row clamp", () => {
  type Row = Record<string, unknown>;

  const PREV = {
    id: "prev-child",
    name: "CA (2026-07-29)",
    status: "paused",
    vapi_assistant_id: null,
    vapi_pool_slot_id: null,
  };

  // 1,100 pending + 720 pending_retry (= 1,820 open, spanning 2 pages) + 3
  // terminal rows that must NOT carry. Zero-padded ids sort lexicographically.
  function dataset(): Row[] {
    const rows: Row[] = [];
    for (let i = 0; i < 1100; i++)
      rows.push({
        id: `p${String(i).padStart(4, "0")}`,
        campaign_id: "prev-child",
        phone_e164: `+1416555${String(i).padStart(4, "0")}`,
        attempt_count: 0,
        outcome: "pending",
        display_name: i === 0 ? "Vicky Seavers" : null,
      });
    for (let i = 0; i < 720; i++)
      rows.push({
        id: `r${String(i).padStart(4, "0")}`,
        campaign_id: "prev-child",
        phone_e164: `+1647555${String(i).padStart(4, "0")}`,
        attempt_count: 2,
        outcome: "pending_retry",
        display_name: null,
      });
    rows.push({ id: "t0001", campaign_id: "prev-child", phone_e164: "+10000000001", attempt_count: 1, outcome: "sent_sms", display_name: null });
    rows.push({ id: "t0002", campaign_id: "prev-child", phone_e164: "+10000000002", attempt_count: 3, outcome: "unreached", display_name: null });
    rows.push({ id: "t0003", campaign_id: "prev-child", phone_e164: "+10000000003", attempt_count: 1, outcome: "sms_delivered", display_name: null });
    return rows;
  }

  // Chainable mock: serves the prev-child lookup, applies eq/in filters over
  // the dataset with the 1000-row clamp on EVERY read (range or not), captures
  // inserts and close-update batches, returns 0 in-flight calls, and answers
  // the child-close update with closed=null (skips the Vapi cleanup import).
  // `failPagesFrom`: offset at which reads start erroring (whole-or-nothing test).
  function makeClient(rows: Row[], opts?: { failPagesFrom?: number }) {
    const inserted: Row[][] = [];
    const closeBatches: string[][] = [];
    function builder(table: string) {
      const q: {
        eqs: Array<[string, unknown]>;
        ins: Array<[string, unknown[]]>;
        insertArg?: Row[];
        updateArg?: Row;
        range?: [number, number];
        head?: boolean;
      } = { eqs: [], ins: [] };
      const resolve = (): unknown => {
        if (table === "calls_v2") return { count: 0, error: null };
        if (table === "campaign_numbers_v2" && q.insertArg) {
          inserted.push(q.insertArg);
          return { error: null };
        }
        if (table === "campaign_numbers_v2" && q.updateArg) {
          const idIn = q.ins.find(([col]) => col === "id");
          closeBatches.push((idIn ? idIn[1] : []) as string[]);
          return { error: null };
        }
        if (table === "campaign_numbers_v2") {
          let out = rows.filter((r) => q.eqs.every(([c, v]) => r[c] === v));
          for (const [col, vals] of q.ins) out = out.filter((r) => vals.includes(r[col]));
          out = [...out].sort((a, b) => String(a.id).localeCompare(String(b.id)));
          const from = q.range ? q.range[0] : 0;
          if (opts?.failPagesFrom !== undefined && from >= opts.failPagesFrom) {
            return { data: null, error: { message: "boom page" } };
          }
          const to = q.range ? q.range[1] : Infinity;
          // PostgREST max-rows: never more than 1000 per request, range or not.
          return { data: out.slice(from, Math.min(to + 1, from + 1000)), error: null };
        }
        return { data: null, error: null };
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "lt", "in", "order", "limit", "range", "update", "insert"]) {
        b[m] = (...args: unknown[]) => {
          if (m === "eq") q.eqs.push(args as [string, unknown]);
          if (m === "in") q.ins.push(args as [string, unknown[]]);
          if (m === "insert") q.insertArg = args[0] as Row[];
          if (m === "update") q.updateArg = args[0] as Row;
          if (m === "range") q.range = [args[0] as number, args[1] as number];
          return b;
        };
      }
      b.maybeSingle = () =>
        Promise.resolve(q.updateArg ? { data: null, error: null } : { data: PREV, error: null });
      b.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR);
      return b;
    }
    return { client: { from: builder } as never, inserted, closeBatches };
  }

  beforeEach(async () => {
    // The module-level mock stubs fetchAllRows to [] for the poll test above;
    // rollover needs the REAL pagination behavior.
    const actual = await vi.importActual<typeof import("../supabaseFetchAll")>("../supabaseFetchAll");
    vi.mocked(fetchAllRows).mockImplementation(actual.fetchAllRows);
  });

  it("carries ALL 1,820 open rows (not the first 1000) and closes exactly those, in <=200-id batches", async () => {
    const { client, inserted, closeBatches } = makeClient(dataset());

    const result = await rolloverLeftovers(client, "parent-1", "child-new", "2026-07-30T04:00:00Z");

    expect(result.carried).toBe(1820);
    // One insert containing every open row, none of the terminal ones.
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(1820);
    expect(inserted[0].every((r) => r.campaign_id === "child-new" && r.outcome === "pending")).toBe(true);
    const byPhone = new Map(inserted[0].map((r) => [r.phone_e164, r]));
    expect(byPhone.get("+14165550000")?.display_name).toBe("Vicky Seavers"); // name survives at volume
    expect(byPhone.get("+16475550000")?.attempt_count).toBe(2); // retry count survives (max-tries spans days)
    expect(byPhone.has("+10000000001")).toBe(false); // terminal rows do not carry
    // Close covers every carried row and only carried rows — chunked for URL
    // safety (the .in(id) filter rides the query string; ~1.8k uuids blow it).
    const closedIds = closeBatches.flat();
    expect(closedIds).toHaveLength(1820);
    expect(new Set(closedIds).size).toBe(1820);
    expect(closeBatches.every((b) => b.length <= 200)).toBe(true);
    expect(closedIds).not.toContain("t0001");
  });

  it("whole-or-nothing: a mid-run page failure carries NOTHING (a partial carry would close 1000 and strand the tail)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, inserted, closeBatches } = makeClient(dataset(), { failPagesFrom: 1000 });

    const result = await rolloverLeftovers(client, "parent-1", "child-new", "2026-07-30T04:00:00Z");

    expect(result.carried).toBe(0);
    expect(inserted).toHaveLength(0); // no partial insert
    expect(closeBatches).toHaveLength(0); // no rows closed — all stay open for the next spawn
    expect(spy).toHaveBeenCalled(); // loud, never silent
    spy.mockRestore();
  });
});
