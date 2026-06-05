import { campaignRegion } from "./campaignRegion";

// Client-side sort/filter for the Reviews campaign list. Pure + typed
// structurally (any object with these fields) so it's unit-testable without the
// full ReviewCampaign / React.

export type ReviewSortKey = "newest" | "conversations" | "calls" | "leastLabeled" | "region";

interface SortableCampaign {
  campaignName: string;
  createdAt: string;
  conversationCount: number;
  totalCallCount: number;
  labeledCount: number;
}

const OTHER = "Other";

const regionLabel = (name: string): string => campaignRegion(name) ?? OTHER;
// Fraction of a campaign's conversations this reviewer has labeled (0 = none).
const labeledFraction = (c: SortableCampaign): number =>
  c.conversationCount > 0 ? c.labeledCount / c.conversationCount : 1;

/** Return a NEW array sorted by the chosen key (never mutates the input). */
export function sortReviewCampaigns<T extends SortableCampaign>(list: T[], key: ReviewSortKey): T[] {
  const arr = [...list];
  switch (key) {
    case "newest":
      // createdAt is an ISO string → lexicographic compare is chronological.
      arr.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      break;
    case "conversations":
      arr.sort((a, b) => b.conversationCount - a.conversationCount);
      break;
    case "calls":
      arr.sort((a, b) => b.totalCallCount - a.totalCallCount);
      break;
    case "leastLabeled":
      // Least-labeled first (most review work remaining); tiebreak by size.
      arr.sort((a, b) => labeledFraction(a) - labeledFraction(b) || b.conversationCount - a.conversationCount);
      break;
    case "region":
      // Group by region alphabetically (Other last); within a region, most convos first.
      arr.sort(
        (a, b) =>
          regionLabel(a.campaignName).localeCompare(regionLabel(b.campaignName)) ||
          b.conversationCount - a.conversationCount,
      );
      break;
  }
  return arr;
}

/** Distinct regions present, alpha-sorted, with "Other" appended if any campaign is unregioned. */
export function regionsOf(list: { campaignName: string }[]): string[] {
  let hasOther = false;
  const set = new Set<string>();
  for (const c of list) {
    const r = campaignRegion(c.campaignName);
    if (r) set.add(r);
    else hasOther = true;
  }
  const regions = Array.from(set).sort((a, b) => a.localeCompare(b));
  if (hasOther) regions.push(OTHER);
  return regions;
}

/** Filter by region: "all" = no filter, "Other" = unregioned, else exact region code. */
export function filterByRegion<T extends { campaignName: string }>(list: T[], region: string): T[] {
  if (region === "all") return list;
  if (region === OTHER) return list.filter((c) => campaignRegion(c.campaignName) === null);
  return list.filter((c) => campaignRegion(c.campaignName) === region);
}
