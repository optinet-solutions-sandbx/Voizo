// segmentMemberPager — follow a paginated member fetch to the END of the
// segment (or an operator-set cap), so "whatever number is in Customer.io is
// the number Voizo imports".
//
// WHY THIS EXISTS (2026-07-29): the wizard's segment importer fetched exactly
// ONE page (limit=200) and never followed the `next` cursor the members route
// has returned since day one. A 2,071-member reactivation segment would have
// silently become a 200-number campaign — the UI even said "200 of 200",
// counting the capped page against itself. The server half of pagination
// already existed; this is the missing client half, kept pure so it can be
// unit-tested without React or fetch.
//
// Contract:
// - `fetchPage(start?)` returns one page and the cursor for the next.
// - Follows the cursor until: the segment ends (complete: true), the caller's
//   `cap` is reached (complete: false — deliberately truncated), or PAGE_CAP
//   pages (complete: false — mirrors the server-side fetchAllSegmentPhones
//   safety cap of 10 pages × 1000; ours is 50 × 200 = the same 10,000 ceiling).
// - A page failure THROWS. No silent partial import: a campaign built from
//   "however much we got before the error" is the 200-bug in new clothes.
//   The caller surfaces the error and the operator retries.

export interface MemberPage<M> {
  members: M[];
  /** Opaque Customer.io cursor; null/undefined = last page. */
  next: string | null | undefined;
}

export interface PagerOptions {
  /** Max members to fetch (operator's "Import limit"). null/undefined = all. */
  cap?: number | null;
  /** Called after each page with the running total fetched so far. */
  onProgress?: (fetchedSoFar: number) => void;
}

export interface PagerResult<M> {
  members: M[];
  /** true = the whole segment was fetched; false = stopped at cap or PAGE_CAP. */
  complete: boolean;
}

// 50 pages × 200/page = 10,000 — the same ceiling the server-side segment
// fetch enforces (customerio.ts PAGE_CAP: 10 pages × 1000).
export const MEMBER_PAGE_CAP = 50;

export async function fetchAllSegmentMembers<M>(
  fetchPage: (start?: string) => Promise<MemberPage<M>>,
  options: PagerOptions = {},
): Promise<PagerResult<M>> {
  const cap = typeof options.cap === "number" && options.cap > 0 ? options.cap : null;
  const members: M[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (;;) {
    const page = await fetchPage(cursor); // page failure propagates — no partials
    members.push(...page.members);
    pages++;
    options.onProgress?.(members.length);

    if (cap !== null && members.length >= cap) {
      // Edge honesty: landing EXACTLY on the cap at the segment's last page is
      // a complete fetch, not a truncation — the summary must not claim "first
      // N (limit)" when N is everything there is.
      const truncated = members.length > cap || Boolean(page.next);
      return { members: members.slice(0, cap), complete: !truncated };
    }
    if (!page.next) {
      return { members, complete: true };
    }
    if (pages >= MEMBER_PAGE_CAP) {
      return { members, complete: false };
    }
    cursor = page.next;
  }
}
