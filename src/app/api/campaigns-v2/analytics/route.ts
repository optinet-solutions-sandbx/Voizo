import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  computeCampaignAnalytics,
  type CampaignRow,
  type NumberRow,
  type CallRow,
  type SmsRow,
} from "@/lib/campaignAnalytics";

/**
 * GET /api/campaigns-v2/analytics
 *
 * RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md), reshaped 2026-08-05:
 * computeCampaignAnalytics now runs SERVER-SIDE and the response is the computed
 * per-campaign map (`{ analytics: Record<campaignId, CampaignAnalytics> }`) —
 * aggregates only, ~KBs.
 *
 * WHY the reshape: the route used to return the raw {numbers, calls, sms} bundle
 * for the page to compute client-side. That bundle had grown to ~20.8MB / 44s at
 * 51k calls, and — because the 2026-06-26 engagement classifier needs
 * calls_v2.transcript (substantiveUserTurnCount) — it carried every transcript to
 * the browser while comments here still claimed "never transcript". Computing
 * server-side keeps the transcript read (the classifier requires it) but it never
 * leaves the server; phone_e164 / body are never selected at all.
 *
 * Ghost segregation: campaigns with source='ghost_portal' are dropped BEFORE
 * compute (mirrors the campaigns-v2 list route), so ghost aggregates never ride
 * the wire either.
 *
 * Paginated reads (fetchAllRows): PostgREST caps an unpaginated .select() at
 * 1000 rows. Best-effort per table: a page error degrades that bucket to the
 * rows gathered so far (loud-logged), so one table failing skews rather than
 * blanks the list — matching the old bundle behaviour.
 *
 * NOTE: still the full-table sequential-paging read underneath (~52 pages of
 * calls_v2) — the latency root-fix is the VOZ-289 rollup cutover; this change
 * removes the PII wire leak and the 20MB payload, not the paging cost.
 */
export async function GET() {
  const [campaigns, numbers, calls, sms] = await Promise.all([
    fetchAllRows(
      supabaseAdmin,
      "campaigns_v2",
      "id, name, status, is_test, source, start_at, created_at, end_at, campaign_type, goal_target",
    ),
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "id, campaign_id, outcome, created_at"),
    fetchAllRows(supabaseAdmin, "calls_v2", "campaign_id, campaign_number_id, status, goal_reached, duration_seconds, created_at, voicemail, ended_reason, transcript"),
    fetchAllRows(supabaseAdmin, "sms_messages_v2", "campaign_id, status, provider"),
  ]);

  const realCampaigns = (campaigns as unknown as CampaignRow[]).filter(
    (c) => c.source !== "ghost_portal",
  );

  const analytics = computeCampaignAnalytics({
    campaigns: realCampaigns,
    numbers: numbers as unknown as NumberRow[],
    calls: calls as unknown as CallRow[],
    sms: sms as unknown as SmsRow[],
    now: Date.now(),
  });

  return NextResponse.json({ analytics });
}
