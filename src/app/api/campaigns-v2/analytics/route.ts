import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

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
 * Paginated reads (fetchAllRows): PostgREST caps an unpaginated .select() at
 * 1000 rows, which silently dropped the newest campaigns' numbers/calls (>1000
 * rows total) so the list showed 0 contacts/calls for them. fetchAllRows pages
 * past the cap, ordered by the stable `id` key, so every campaign is counted.
 *
 * Best-effort per table: fetchAllRows logs a page error and returns the rows
 * gathered so far (loud-over-silent), so one table failing degrades that bucket
 * rather than failing the whole bundle.
 */
export async function GET() {
  const [numbers, calls, sms] = await Promise.all([
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "id, campaign_id, outcome, created_at"),
    fetchAllRows(supabaseAdmin, "calls_v2", "campaign_id, campaign_number_id, status, goal_reached, duration_seconds, created_at"),
    fetchAllRows(supabaseAdmin, "sms_messages_v2", "campaign_id, status, provider"),
  ]);

  return NextResponse.json({ numbers, calls, sms });
}
