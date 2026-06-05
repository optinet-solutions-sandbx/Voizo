import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET /api/campaigns-v2/analytics
 *
 * RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md). Returns the
 * campaigns-list aggregation bundle (numbers + calls + SMS) consumed by
 * computeCampaignAnalytics on the campaigns list page. Read SERVER-SIDE via the
 * service role, replacing the page's three inline anon `.select(...)` reads.
 *
 * PII minimization is preserved EXACTLY (the page's "G6" column lists): only
 * aggregation columns are selected — never phone_e164, transcript, body,
 * to_phone_e164, error_message, or provider_message_id — so the wire payload
 * carries no PII even though the route is already auth-gated.
 *
 * No campaign_id filter: the list page fetches ALL campaigns then aggregates by
 * their ids, so "all rows" == "rows for the fetched ids". computeCampaignAnalytics
 * groups by campaign_id and ignores rows for any campaign not on the page.
 *
 * Best-effort per table: a per-table error degrades that bucket to [] (loud-
 * logged) rather than failing the whole bundle — mirrors the page's original
 * loud-over-silent handling (a metric reads 0, never hidden).
 */
export async function GET() {
  const [numbersRes, callsRes, smsRes] = await Promise.all([
    supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, campaign_id, outcome, created_at"),
    supabaseAdmin
      .from("calls_v2")
      .select("campaign_id, campaign_number_id, status, goal_reached, duration_seconds, created_at"),
    supabaseAdmin
      .from("sms_messages_v2")
      .select("campaign_id, status, provider"),
  ]);

  if (numbersRes.error) console.error("[campaigns-v2/analytics] campaign_numbers_v2 read failed:", numbersRes.error);
  if (callsRes.error) console.error("[campaigns-v2/analytics] calls_v2 read failed:", callsRes.error);
  if (smsRes.error) console.error("[campaigns-v2/analytics] sms_messages_v2 read failed (SMS metrics read 0):", smsRes.error);

  return NextResponse.json({
    numbers: numbersRes.data ?? [],
    calls: callsRes.data ?? [],
    sms: smsRes.data ?? [],
  });
}
