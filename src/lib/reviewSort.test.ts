import { describe, it, expect } from "vitest";
import { sortReviewCampaigns, regionsOf, filterByRegion } from "./reviewSort";

type C = {
  campaignName: string;
  createdAt: string;
  conversationCount: number;
  totalCallCount: number;
  labeledCount: number;
};
const mk = (campaignName: string, o: Partial<C> = {}): C => ({
  campaignName,
  createdAt: o.createdAt ?? "2026-01-01T00:00:00Z",
  conversationCount: o.conversationCount ?? 0,
  totalCallCount: o.totalCallCount ?? 0,
  labeledCount: o.labeledCount ?? 0,
});
const names = (list: C[]) => list.map((c) => c.campaignName);

describe("sortReviewCampaigns", () => {
  it("newest: by createdAt descending", () => {
    const list = [
      mk("A", { createdAt: "2026-06-01T00:00:00Z" }),
      mk("B", { createdAt: "2026-06-05T00:00:00Z" }),
      mk("C", { createdAt: "2026-06-03T00:00:00Z" }),
    ];
    expect(names(sortReviewCampaigns(list, "newest"))).toEqual(["B", "C", "A"]);
  });

  it("conversations: by conversationCount descending", () => {
    const list = [mk("A", { conversationCount: 5 }), mk("B", { conversationCount: 55 }), mk("C", { conversationCount: 9 })];
    expect(names(sortReviewCampaigns(list, "conversations"))).toEqual(["B", "C", "A"]);
  });

  it("calls: by totalCallCount descending", () => {
    const list = [mk("A", { totalCallCount: 45 }), mk("B", { totalCallCount: 134 }), mk("C", { totalCallCount: 16 })];
    expect(names(sortReviewCampaigns(list, "calls"))).toEqual(["B", "A", "C"]);
  });

  it("leastLabeled: lowest labeled fraction first (most work remaining)", () => {
    const list = [
      mk("done", { conversationCount: 10, labeledCount: 10 }),
      mk("none", { conversationCount: 10, labeledCount: 0 }),
      mk("half", { conversationCount: 10, labeledCount: 5 }),
    ];
    expect(names(sortReviewCampaigns(list, "leastLabeled"))).toEqual(["none", "half", "done"]);
  });

  it("region: groups by region alphabetically, Other (no region) last", () => {
    const list = [
      mk("L7_CA_VOIZO_x", { conversationCount: 1 }),
      mk("test foo", { conversationCount: 9 }),
      mk("L7_AU_VOIZO_x", { conversationCount: 1 }),
    ];
    expect(names(sortReviewCampaigns(list, "region"))).toEqual(["L7_AU_VOIZO_x", "L7_CA_VOIZO_x", "test foo"]);
  });

  it("does not mutate the input array", () => {
    const list = [mk("A", { conversationCount: 1 }), mk("B", { conversationCount: 2 })];
    const before = names(list);
    sortReviewCampaigns(list, "conversations");
    expect(names(list)).toEqual(before);
  });
});

describe("regionsOf", () => {
  it("returns unique regions alpha-sorted with Other last when any are unregioned", () => {
    const list = [mk("L7_CA_x"), mk("L7_AU_x"), mk("L7_AU_y"), mk("test z")];
    expect(regionsOf(list)).toEqual(["AU", "CA", "Other"]);
  });
  it("omits Other when every campaign has a region", () => {
    expect(regionsOf([mk("L7_CA_x"), mk("L7_AU_x")])).toEqual(["AU", "CA"]);
  });
});

describe("filterByRegion", () => {
  const list = [mk("L7_CA_x"), mk("L7_AU_x"), mk("test z")];
  it("'all' returns everything", () => {
    expect(names(filterByRegion(list, "all"))).toEqual(["L7_CA_x", "L7_AU_x", "test z"]);
  });
  it("a region code returns only that region", () => {
    expect(names(filterByRegion(list, "CA"))).toEqual(["L7_CA_x"]);
  });
  it("'Other' returns only the unregioned campaigns", () => {
    expect(names(filterByRegion(list, "Other"))).toEqual(["test z"]);
  });
});
