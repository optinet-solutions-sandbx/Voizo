import { NextRequest, NextResponse } from "next/server";
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
 * GET /api/dashboard/campaigns/[id]/analytics
 *
 * The full LIFETIME CampaignAnalytics deep-dive for ONE campaign — the data behind the
 * dashboard Campaign Performance row's rich expand (CampaignExpand: summary + funnel /
 * duration / failure-mix / retry-payoff / 9 metrics + CSV/JSON export). Lazy: fetched only
 * when a row is expanded, so the dashboard glance stays light.
 *
 * Mirrors the campaigns-list bundle (/api/campaigns-v2/analytics) columns — PII-minimized
 * (never phone_e164 / transcript / body) — but scoped to this campaign via the shared
 * fetchAllRows `eq` filter so it pages past PostgREST's 1000-row cap (a single hot campaign
 * can exceed it). LIFETIME (not date-bounded) so the deep-dive matches the /campaigns expand;
 * the table row's calls/connect/success stay window-bounded by design.
 *
 * Ghost runs return null (segregation, mirrors the [id]/records route). Read-only; lenient origin.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const { id } = await params;

  // The campaign row doubles as the ghost segregation check + the computeCampaignAnalytics input.
  const { data: camp, error: campErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, is_test, source, start_at, created_at, end_at, campaign_type")
    .eq("id", id)
    .single();
  if (campErr || !camp) {
    return NextResponse.json({ analytics: null });
  }
  if ((camp as { source?: string | null }).source === "ghost_portal") {
    return NextResponse.json({ analytics: null }); // ghost segregation
  }

  const eq = { column: "campaign_id", value: id };
  const [numbers, calls, sms] = await Promise.all([
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "id, campaign_id, outcome, created_at", "id", eq),
    fetchAllRows(supabaseAdmin, "calls_v2", "campaign_id, campaign_number_id, status, goal_reached, duration_seconds, created_at, voicemail", "id", eq),
    fetchAllRows(supabaseAdmin, "sms_messages_v2", "campaign_id, status, provider", "id", eq),
  ]);

  const byId = computeCampaignAnalytics({
    campaigns: [camp] as unknown as CampaignRow[],
    numbers: numbers as unknown as NumberRow[],
    calls: calls as unknown as CallRow[],
    sms: sms as unknown as SmsRow[],
    now: Date.now(),
  });

  return NextResponse.json({ analytics: byId[id] ?? null });
}
