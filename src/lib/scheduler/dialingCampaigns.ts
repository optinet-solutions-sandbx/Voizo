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
