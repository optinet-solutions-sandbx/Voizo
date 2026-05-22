// Module-level cache for the campaign-duplicate prefill response.
//
// Both the Duplicate modal in src/app/campaigns/v2/[id]/page.tsx AND the
// wizard mount in src/app/campaigns/v2/new/page.tsx fetch the same
// /api/campaigns-v2/[id]/duplicate endpoint. That endpoint internally calls
// fetchSegmentPhones() which paginates the Customer.io API — 10-30s for
// segments under 500. Without this cache, every operator-driven duplicate
// triggers two CIO fetches: one for the modal's diff preview, one for the
// wizard's prefill.
//
// The modal writes the full response after its fetch. The wizard's mount
// effect reads + deletes the entry (single-use) before falling back to its
// own fetch. The wizard then applies the operator's skip CSV client-side
// to compute the filtered phones list — same algorithm as the server, just
// run on the bucket sets the server already returned.
//
// TTL is 60 seconds so a slow operator who pauses mid-flow gets fresh
// data instead of a stale view. A refreshSegment mismatch (modal was true,
// wizard wants false or vice versa) also invalidates — the cached buckets
// are tied to the data they were computed from.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DuplicatePrefillBody = any;

interface CacheEntry {
  body: DuplicatePrefillBody;
  refreshSegment: boolean;
  ts: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

export function setDuplicatePrefillCache(
  campaignId: string,
  body: DuplicatePrefillBody,
  refreshSegment: boolean,
): void {
  cache.set(campaignId, { body, refreshSegment, ts: Date.now() });
}

export function consumeDuplicatePrefillCache(
  campaignId: string,
  refreshSegment: boolean,
): DuplicatePrefillBody | null {
  const entry = cache.get(campaignId);
  if (!entry) return null;
  cache.delete(campaignId); // single-use — fall back to fetch on next mount
  if (entry.refreshSegment !== refreshSegment) return null;
  if (Date.now() - entry.ts > TTL_MS) return null;
  return entry.body;
}
