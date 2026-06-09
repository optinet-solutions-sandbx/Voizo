import { describe, it, expect } from "vitest";
import { scrubGhostPhones } from "./ghostScrub";

// Thenable builder per table — every chain method returns the builder, and the
// builder resolves (await / Promise.all) to the table's canned rows. Covers both
// the dncSuppressedSet chain (.select().in(), .select().eq().in()) and the
// recency chain (.select().in().in().gt()). Relative imports only.
function fakeSupabase(map: { suppression_list?: string[]; do_not_call?: string[]; campaign_numbers_v2?: string[] }) {
  const tableRows = (t: string): unknown[] => {
    if (t === "suppression_list") return (map.suppression_list ?? []).map((p) => ({ phone_e164: p }));
    if (t === "do_not_call") return (map.do_not_call ?? []).map((p) => ({ phone_number: p }));
    if (t === "campaign_numbers_v2") return (map.campaign_numbers_v2 ?? []).map((p) => ({ phone_e164: p }));
    return [];
  };
  return {
    from(t: string) {
      const result = { data: tableRows(t), error: null };
      const b: any = {
        select: () => b, eq: () => b, in: () => b, gt: () => b,
        then: (resolve: (v: typeof result) => void) => resolve(result),
      };
      return b;
    },
  } as any;
}

const A = "+15551110000";
const B = "+15552220000";
const C = "+15553330000";

describe("scrubGhostPhones", () => {
  it("excludes DNC/suppression phones from net in BOTH tiers (recency off)", async () => {
    const supabase = fakeSupabase({ suppression_list: [A], do_not_call: [B] });
    const r = await scrubGhostPhones(supabase, [A, B, C], { applyRecency: false });
    expect(r.net).toEqual([C]);
    expect(r.uploaded).toBe(3);
    expect(r.suppressed).toBe(2);
    expect(r.suppressedDnc).toBe(2);
    expect(r.suppressedRecent).toBe(0);
  });

  it("also excludes recently-contacted phones when applyRecency=true (live tier)", async () => {
    const supabase = fakeSupabase({ suppression_list: [A], campaign_numbers_v2: [B] });
    const r = await scrubGhostPhones(supabase, [A, B, C], { applyRecency: true, recentWindowDays: 7 });
    expect(r.net).toEqual([C]);
    expect(r.suppressedDnc).toBe(1);
    expect(r.suppressedRecent).toBe(1);
    expect(r.suppressed).toBe(2);
  });

  it("does NOT apply recency when applyRecency=false even if rows exist", async () => {
    const supabase = fakeSupabase({ campaign_numbers_v2: [B] });
    const r = await scrubGhostPhones(supabase, [A, B, C], { applyRecency: false });
    expect(r.net).toEqual([A, B, C]);
    expect(r.suppressedRecent).toBe(0);
  });

  it("returns all-zero / empty for an empty phone list (no query)", async () => {
    const r = await scrubGhostPhones(fakeSupabase({}), [], { applyRecency: true });
    expect(r).toEqual({ uploaded: 0, suppressed: 0, net: [], suppressedDnc: 0, suppressedRecent: 0 });
  });

  it("dedupes the input defensively (uploaded counts unique phones)", async () => {
    const r = await scrubGhostPhones(fakeSupabase({}), [A, A, B], { applyRecency: false });
    expect(r.uploaded).toBe(2);
    expect(r.net).toEqual([A, B]);
  });
});
