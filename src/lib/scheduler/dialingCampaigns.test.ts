import { describe, it, expect } from "vitest";
import { countDialingCampaigns, countDueNumbers } from "./dialingCampaigns";

// The 2026-08-25 outage was a gate that counted the wrong thing (leased slots,
// which drafts and breaker-paused children also hold). These tests pin the
// filter shape: drop either filter and the count is back to something that can
// deadlock the fleet. fakeSupabase mirrors .from().select().eq().not() and
// records every filter it was handed.
function fakeSupabase(count: number | null, error: { message: string } | null = null) {
  const filters: Array<[string, ...unknown[]]> = [];
  const capture: { table?: string; select?: [string, unknown] } = {};
  const chain = {
    select: (cols: string, opts: unknown) => { capture.select = [cols, opts]; return chain; },
    eq: (...a: unknown[]) => { filters.push(["eq", ...a]); return chain; },
    not: (...a: unknown[]) => { filters.push(["not", ...a]); return chain; },
    then: (resolve: (v: unknown) => void) => resolve({ count, error }),
  };
  return { client: { from: (t: string) => { capture.table = t; return chain; } } as never, capture, filters };
}

describe("countDialingCampaigns (queue-gate input, 2026-08-25 deadlock)", () => {
  it("counts campaigns_v2 rows that are running AND hold a slot — nothing else", async () => {
    const { client, capture, filters } = fakeSupabase(4);
    expect(await countDialingCampaigns(client)).toEqual({ count: 4, error: null });
    expect(capture.table).toBe("campaigns_v2");
    // head:true + exact count — a count query, never a row fetch
    expect(capture.select).toEqual(["id", { count: "exact", head: true }]);
    expect(filters).toEqual([
      ["eq", "status", "running"],
      ["not", "vapi_pool_slot_id", "is", null],
    ]);
  });

  it("does NOT read vapi_sip_pool — leased slots include drafts and breaker-paused children", async () => {
    const { client, capture } = fakeSupabase(0);
    await countDialingCampaigns(client);
    expect(capture.table).not.toBe("vapi_sip_pool");
  });

  it("passes a query error through untouched so the gate can fail closed", async () => {
    const { client } = fakeSupabase(null, { message: "boom" });
    expect(await countDialingCampaigns(client)).toEqual({ count: null, error: { message: "boom" } });
  });
});

// VOZ-520 alert noise (2026-09-14): the heartbeat's "stuck running campaign" looked 60min
// ahead for a coming retry, so a number parked by the 12h route-refusal deferral
// (hangupOutcome.ts ROUTE_REFUSAL_DEFER_HOURS) read as "stuck" for 11 hours and re-alerted
// every 30 min — 37 SIP-500 casualties produced ~25 false alarms in one day. "Due" is
// the dialer's own eligibility (findNextNumber): pending, or a retry whose time HAS come,
// under max_attempts. This helper is that query, written once, used by the heartbeat and
// by the anomaly sweep's dial-silence detector. fakeDueSupabase mirrors
// .from().select().eq().lt().or() and records every filter it was handed.
function fakeDueSupabase(count: number | null, error: { message: string } | null = null) {
  const filters: Array<[string, ...unknown[]]> = [];
  const capture: { table?: string; select?: [string, unknown] } = {};
  const chain = {
    select: (cols: string, opts: unknown) => { capture.select = [cols, opts]; return chain; },
    eq: (...a: unknown[]) => { filters.push(["eq", ...a]); return chain; },
    lt: (...a: unknown[]) => { filters.push(["lt", ...a]); return chain; },
    or: (...a: unknown[]) => { filters.push(["or", ...a]); return chain; },
    then: (resolve: (v: unknown) => void) => resolve({ count, error }),
  };
  return { client: { from: (t: string) => { capture.table = t; return chain; } } as never, capture, filters };
}

describe("countDueNumbers (the dialer's own 'due' definition, shared by heartbeat + anomaly sweep)", () => {
  const NOW = "2026-09-14T08:00:00.000Z";

  it("counts pending numbers plus retries whose time has come, under max_attempts — nothing else", async () => {
    const { client, capture, filters } = fakeDueSupabase(2);
    expect(await countDueNumbers(client, "camp-1", 3, NOW)).toEqual({ count: 2, error: null });
    expect(capture.table).toBe("campaign_numbers_v2");
    expect(capture.select).toEqual(["id", { count: "exact", head: true }]);
    expect(filters).toEqual([
      ["eq", "campaign_id", "camp-1"],
      ["lt", "attempt_count", 3],
      ["or", `outcome.eq.pending,and(outcome.eq.pending_retry,next_attempt_at.lte.${NOW})`],
    ]);
  });

  it("a retry timer in the future is NOT due — the cutoff is NOW, never a lookahead", async () => {
    const { client, filters } = fakeDueSupabase(0);
    await countDueNumbers(client, "camp-1", 3, NOW);
    const orClause = String(filters.find((f) => f[0] === "or")?.[1]);
    expect(orClause).toContain(`next_attempt_at.lte.${NOW}`);
    expect(orClause).not.toMatch(/gte|gt\./);
  });

  it("passes a query error through untouched so callers can fail open or closed as they choose", async () => {
    const { client } = fakeDueSupabase(null, { message: "boom" });
    expect(await countDueNumbers(client, "camp-1", 3, NOW)).toEqual({ count: null, error: { message: "boom" } });
  });
});
