import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  computeMetricBreakdown,
  type BreakdownCallRow,
  type BreakdownCampaignRow,
  type BreakdownSmsRow,
} from "@/lib/metricBreakdown";

/**
 * GET /api/dashboard/metric-breakdown
 *
 * Region × time (today / yesterday / rolling-7d) breakdown behind the clickable KPI cards'
 * slide-over report (dashboard-metric-drilldown spec, Feature 2). Aggregation-only columns
 * (G6 — never phone/transcript/body); read SERVER-SIDE via the service role. Ghost + test
 * campaigns are excluded inside computeMetricBreakdown.
 *
 * Read-only, no side effects. Lenient origin policy (GET — same as /api/dashboard/today).
 * 8-day call window covers today + yesterday + the rolling 7d; JS-side aggregation is fine at
 * PoC volume (≈hundreds of rows/8d, under the PostgREST 1000 cap — matches the today route).
 */
const MS_PER_DAY = 86_400_000;

export async function GET(request: NextRequest) {
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

  const now = Date.now();
  const cutoff = new Date(now - 8 * MS_PER_DAY).toISOString();

  const [callsRes, campaignsRes, smsRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select("campaign_id, status, goal_reached, created_at")
      .gte("created_at", cutoff),
    supabaseAdmin.from("campaigns_v2").select("id, name, source, is_test"),
    supabaseAdmin
      .from("sms_messages_v2")
      .select("campaign_id, created_at")
      .gte("created_at", cutoff),
  ]);

  if (callsRes.error || campaignsRes.error || smsRes.error) {
    console.error(
      "[dashboard/metric-breakdown] query failed:",
      callsRes.error ?? campaignsRes.error ?? smsRes.error,
    );
    return NextResponse.json({ error: "Failed to read breakdown" }, { status: 500 });
  }

  const breakdown = computeMetricBreakdown({
    now,
    calls: (callsRes.data ?? []) as unknown as BreakdownCallRow[],
    campaigns: (campaignsRes.data ?? []) as unknown as BreakdownCampaignRow[],
    sms: (smsRes.data ?? []) as unknown as BreakdownSmsRow[],
  });

  return NextResponse.json(breakdown);
}
