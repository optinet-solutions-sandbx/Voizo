// Pins for the segment-member pager — the client half of pagination whose
// absence caused the "2,071-member segment silently becomes a 200-number
// campaign" defect (2026-07-29). Every stop condition is pinned: reintroduce
// a single-page fetch (or a silent partial on error) and these fail loudly.
import { describe, expect, it, vi } from "vitest";
import { MEMBER_PAGE_CAP, fetchAllSegmentMembers } from "./segmentMemberPager";

/** Fake CIO: `total` members served in pages of `pageSize`, cursor = offset. */
function fakePages(total: number, pageSize: number) {
  return vi.fn(async (start?: string) => {
    const offset = start ? parseInt(start, 10) : 0;
    const members = Array.from(
      { length: Math.min(pageSize, total - offset) },
      (_, i) => ({ id: `m${offset + i}` }),
    );
    const nextOffset = offset + members.length;
    return { members, next: nextOffset < total ? String(nextOffset) : null };
  });
}

describe("fetchAllSegmentMembers", () => {
  it("follows the cursor to the END of a multi-page segment (the 200-bug pin)", async () => {
    const fetchPage = fakePages(2071, 200);
    const res = await fetchAllSegmentMembers(fetchPage, {});
    expect(res.members).toHaveLength(2071);
    expect(res.complete).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(11); // 10×200 + 71
    expect(res.members[2070]).toEqual({ id: "m2070" });
  });

  it("stops at the operator cap mid-segment and reports truncation", async () => {
    const res = await fetchAllSegmentMembers(fakePages(2071, 200), { cap: 1000 });
    expect(res.members).toHaveLength(1000);
    expect(res.complete).toBe(false); // more members exist beyond the cap
  });

  it("slices to the cap when a page overshoots it", async () => {
    const res = await fetchAllSegmentMembers(fakePages(500, 200), { cap: 250 });
    expect(res.members).toHaveLength(250);
    expect(res.members[249]).toEqual({ id: "m249" });
    expect(res.complete).toBe(false);
  });

  it("cap landing exactly on the last page is COMPLETE, not truncated", async () => {
    const res = await fetchAllSegmentMembers(fakePages(400, 200), { cap: 400 });
    expect(res.members).toHaveLength(400);
    expect(res.complete).toBe(true); // the cap equalled everything there is
  });

  it("throws on a mid-pagination failure — no silent partial import", async () => {
    let calls = 0;
    const fetchPage = async (start?: string) => {
      calls++;
      if (calls === 2) throw new Error("CIO 429");
      return { members: [{ id: `p${start ?? 0}` }], next: String(calls) };
    };
    await expect(fetchAllSegmentMembers(fetchPage, {})).rejects.toThrow("CIO 429");
  });

  it("hard-stops at MEMBER_PAGE_CAP pages and reports incomplete", async () => {
    const endless = async (start?: string) => ({
      members: [{ id: start ?? "0" }],
      next: String((start ? parseInt(start, 10) : 0) + 1),
    });
    const res = await fetchAllSegmentMembers(endless, {});
    expect(res.members).toHaveLength(MEMBER_PAGE_CAP);
    expect(res.complete).toBe(false);
  });

  it("reports running progress after every page", async () => {
    const seen: number[] = [];
    await fetchAllSegmentMembers(fakePages(450, 200), { onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([200, 400, 450]);
  });

  it("treats a non-positive cap as 'no cap'", async () => {
    const res = await fetchAllSegmentMembers(fakePages(300, 200), { cap: 0 });
    expect(res.members).toHaveLength(300);
    expect(res.complete).toBe(true);
  });
});
