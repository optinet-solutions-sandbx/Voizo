// Realtime queue visibility (VOZ-186).
//
// Between a signup's claim (realtime_seen_members status='waiting') and its
// promotion into a dial row, the player was invisible in the UI — the 07-22
// trial's 6-minute blind spot. These pure helpers shape the waiting claims
// into operator-legible queue rows for the campaign detail page: who's in
// line, since when, and when the phone should ring.
//
// Pure module (no supabase, no Date.now()) so vitest locks the countdown
// math; callers pass the clock in, matching the RunFlowStrip nowMs pattern.

export interface QueueRow {
  cioId: string;
  displayName: string | null;
  phone: string | null;
  /** Raw first_seen_at as stored — kept even when unparseable, for display. */
  joinedAt: string;
  /** first_seen_at + call delay. null = no delay configured (cap-gated wait)
   *  or unparseable timestamp — both render as a non-countdown label. */
  etaMs: number | null;
}

/** Shape 'waiting' claim rows into queue entries, oldest first. */
export function shapeQueueRows(
  rows: Array<Record<string, unknown>>,
  delayMinutes: number | null,
): QueueRow[] {
  const shaped = rows.map((r) => {
    const joinedAt = typeof r.first_seen_at === "string" ? r.first_seen_at : "";
    const joinedMs = Date.parse(joinedAt); // NaN on garbage → etaMs null below
    const etaMs =
      delayMinutes != null && Number.isFinite(joinedMs)
        ? joinedMs + delayMinutes * 60_000
        : null;
    return {
      cioId: typeof r.cio_id === "string" ? r.cio_id : "",
      displayName: typeof r.display_name === "string" && r.display_name ? r.display_name : null,
      phone: typeof r.phone_e164 === "string" && r.phone_e164 ? r.phone_e164 : null,
      joinedAt,
      etaMs,
    };
  });
  // Oldest first — the order the promotion pass serves them.
  return shaped.sort((a, b) => {
    const am = Date.parse(a.joinedAt);
    const bm = Date.parse(b.joinedAt);
    return (Number.isFinite(am) ? am : Infinity) - (Number.isFinite(bm) ? bm : Infinity);
  });
}

/** Plain-language countdown for a queue row (operator-legible, no jargon). */
export function ringsInLabel(etaMs: number | null, nowMs: number): string {
  if (etaMs == null) return "waiting for a free slot";
  const remaining = etaMs - nowMs;
  if (remaining <= 0) return "any moment now";
  if (remaining < 60_000) return "rings in <1 min";
  return `rings in ~${Math.ceil(remaining / 60_000)} min`;
}
