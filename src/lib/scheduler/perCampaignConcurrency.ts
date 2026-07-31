// Per-campaign dial concurrency (K) — the fix for "the campaign can't finish
// everyone in a day". The dialer places ONE call at a time per campaign, so a
// campaign's throughput is capped at ~3600/median-gap dials/hour (~140/h at the
// observed 26s cadence). Clearing ~1,820 players in an 11h window needs ~166/h,
// which is above that ceiling — so a single lane physically cannot finish,
// regardless of phone numbers. Letting a campaign keep K calls in flight lifts
// the ceiling K-fold (K=2 → ~280/h → clears 1,820 in ~6.5h).
//
// Pure + side-effect-free (no env read, no Date, no supabase) so it unit-tests
// without the service-role singleton — same pattern as stuckSweep / hangupOutcome.
// The route reads process.env at the edge and passes the raw string in here.
//
// SHIPS AT DEFAULT 1: dialsToFire(inFlight, 1) === the old `if (inFlight>0) skip;
// else fire one` behaviour exactly, so deploying this is a no-op until an operator
// raises PER_CAMPAIGN_CONCURRENCY. Raise it only after the SquareTalk trunk channel
// count is confirmed and while keeping runningCampaigns × K ≤ Vapi's concurrency cap.

// Hard ceiling on K so a mistyped env can never flood the trunk / Vapi. 10 = Vapi's
// current included concurrency; a single campaign should never target more than the
// whole account can carry.
const MAX_PER_CAMPAIGN_CONCURRENCY = 10;

/**
 * Resolve the PER_CAMPAIGN_CONCURRENCY env value to a safe integer in [1, 10].
 * Unset / blank / garbage → 1 (the no-op default). 0 or negative → 1 (never stop
 * all dialing). Over the cap → 10. Fractional strings truncate (parseInt).
 */
export function resolvePerCampaignConcurrency(raw: string | undefined | null): number {
  const parsed = parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return 1;
  if (parsed < 1) return 1;
  if (parsed > MAX_PER_CAMPAIGN_CONCURRENCY) return MAX_PER_CAMPAIGN_CONCURRENCY;
  return parsed;
}

/**
 * How many NEW calls to fire this tick to bring a campaign up to its concurrency
 * target. Never negative (an overlapping-tick race can leave inFlight above K).
 */
export function dialsToFire(inFlight: number, concurrency: number): number {
  return Math.max(0, concurrency - inFlight);
}
