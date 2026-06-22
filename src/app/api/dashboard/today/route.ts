import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  computeToday,
  type DashCallRow,
  type DashCampaignRow,
  type DashSmsRow,
} from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/today
 *
 * Always-live "Today's Performance" snapshot (Val's spec, 2026-06-15) — this is
 * the section that is NEVER touched by the global filters. Ghost (source=
 * 'ghost_portal') and test campaigns are excluded inside computeToday().
 *
 * Definitions (see dashboardAnalytics.ts): connectRate = connected/terminal where
 * connected == 'completed' (ANSWER, incl. voicemail); successRate = goal_reached/connected.
 *
 * Read-only, no side effects. Lenient origin policy (same as /api/dashboard/metrics).
 * Aggregation is JS-side over an 8-day call window — fine at PoC volume; promote to
 * a SQL rollup only if it proves slow.
 */
const MS_PER_DAY = 86_400_000;

export async function GET(request: NextRequest) {
  // Lenient origin check (GET — same policy as /api/dashboard/metrics).
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
  // 8 days back covers today + the prior-7-day average window.
  const callsCutoff = new Date(now - 8 * MS_PER_DAY).toISOString();
  // SMS only needs today; pull 2 days for clock-skew safety.
  const smsCutoff = new Date(now - 2 * MS_PER_DAY).toISOString();

  const [callsRes, campaignsRes, smsRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select("campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail")
      .gte("created_at", callsCutoff),
    supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, start_at, created_at, end_at"),
    supabaseAdmin
      .from("sms_messages_v2")
      .select("campaign_id, created_at, status")
      .gte("created_at", smsCutoff),
  ]);

  if (callsRes.error || campaignsRes.error || smsRes.error) {
    console.error(
      "[dashboard/today] query failed:",
      callsRes.error ?? campaignsRes.error ?? smsRes.error,
    );
    return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
  }

  const snapshot = computeToday(
    (callsRes.data ?? []) as unknown as DashCallRow[],
    (campaignsRes.data ?? []) as unknown as DashCampaignRow[],
    (smsRes.data ?? []) as unknown as DashSmsRow[],
    now,
  );

  return NextResponse.json(snapshot);
}
