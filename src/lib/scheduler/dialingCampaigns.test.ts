import { describe, it, expect } from "vitest";
import { countDialingCampaigns } from "./dialingCampaigns";

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
