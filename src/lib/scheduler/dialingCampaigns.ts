import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * How many campaigns can place a call RIGHT NOW: status='running' and holding a
 * SIP-pool slot. This is the number the scheduler's queue gate caps at
 * CAMPAIGN_CONCURRENCY_LIMIT.
 *
 * The gate used to count vapi_sip_pool rows with status='leased'. That was the
 * same number until recurring spawn started leasing a slot for each child AT
 * SPAWN — while the child is still 'draft', waiting on the very gate that then
 * counts it. 2026-08-24/25: 8 overnight drafts + 2 breaker-paused CA children
 * (a breaker pause keeps its slot so the resume is a cheap status flip) = 10 =
 * the limit → the gate returned before the draft→running promotion on every
 * tick → zero dials fleet-wide for 16.5h. The same arithmetic had cost NZ its
 * first hour every night since the 4th NZ parent was created (2026-08-21).
 *
 * Recurring parents never hold a slot (the spawner leases for the child), so
 * they fall out on the slot filter without a campaign_type clause. A paused or
 * draft campaign holding a slot is not dialling and must not count.
 */
export async function countDialingCampaigns(
  supabase: SupabaseClient,
): Promise<{ count: number | null; error: { message: string } | null }> {
  const { count, error } = await supabase
    .from("campaigns_v2")
    .select("id", { count: "exact", head: true })
    .eq("status", "running")
    .not("vapi_pool_slot_id", "is", null);
  return { count, error };
}

/**
 * Numbers the dialer would fire RIGHT NOW for a campaign — findNextNumber's own
 * eligibility: outcome pending, or a pending_retry whose next_attempt_at has passed,
 * and under max_attempts. `nowIso` is a parameter so the callers share one clock per
 * tick and a test can pin the cutoff.
 *
 * Written once for the two watchers that ask "is there work the dialer is not doing?":
 * campaign-heartbeat's stuck detector and anomalySweep's dial-silence detector. The
 * heartbeat used to look 60min AHEAD for a coming retry instead, so a number parked by
 * the 12h route-refusal deferral (hangupOutcome.ts ROUTE_REFUSAL_DEFER_HOURS) read as
 * "stuck" for 11 hours and re-alerted every 30 minutes — 2026-09-14: 37 SIP-500
 * casualties across five children produced ~25 false alarms in one day.
 */
export async function countDueNumbers(
  supabase: SupabaseClient,
  campaignId: string,
  maxAttempts: number,
  nowIso: string,
): Promise<{ count: number | null; error: { message: string } | null }> {
  const { count, error } = await supabase
    .from("campaign_numbers_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .lt("attempt_count", maxAttempts)
    .or(`outcome.eq.pending,and(outcome.eq.pending_retry,next_attempt_at.lte.${nowIso})`);
  return { count, error };
}
