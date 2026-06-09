// Prod-priority ordering for the campaign-scheduler's draft→running pick.
// Production drafts must auto-start before internal GhostPortal drafts so a
// ghost run can never jump ahead of a client campaign for the tick's single
// start slot. (Ghost's PRIMARY headroom guard is leaseSlotForGhost's reserve
// floor; this ordering is the secondary "prod gets first dibs" guard.)
//
// Pure + side-effect-free (no mutation, no supabase) so it unit-tests without
// the env-throwing service-role singleton. The scheduler still starts at most
// one draft per tick — it slices the first element of this ordering.

type DraftLike = { source?: string | null; start_at?: string | null };

export function orderDraftsProdFirst<T extends DraftLike>(drafts: T[]): T[] {
  const isGhost = (d: DraftLike) => d.source === "ghost_portal";
  return [...drafts].sort((a, b) => {
    const ag = isGhost(a) ? 1 : 0;
    const bg = isGhost(b) ? 1 : 0;
    if (ag !== bg) return ag - bg; // production (0) before ghost (1)
    // FIFO within the same source: earliest start_at first.
    return String(a.start_at ?? "").localeCompare(String(b.start_at ?? ""));
  });
}
