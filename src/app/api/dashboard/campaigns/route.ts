import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { computeCampaignTable, type DashCallRow, type DashCampaignRow } from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/campaigns?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Rows for the Campaign Performance table (Val's spec). This table has its OWN date
 * range — independent of the global filter bar. Returns ALL live (non-ghost, non-test)
 * campaigns, including zero-call ones, each with a derived DISPLAY status
 * (paused-but-stale → "Ended"; past end_at → "Completed"; presentation-only).
 * Read-only; lenient origin.
 */
const MS_PER_DAY = 86_400_000;
const ENDED_IDLE_DAYS = 7;

function parseDay(value: string | null, fallbackMs: number, endOfDay: boolean): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return fallbackMs;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return endOfDay ? base + MS_PER_DAY - 1 : base;
}

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
  const { searchParams } = new URL(request.url);
  const toMs = parseDay(searchParams.get("to"), now, true);
  const fromMs = parseDay(searchParams.get("from"), now - 30 * MS_PER_DAY, false);

  const [callsRes, campaignsRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select("campaign_id, campaign_number_id, status, goal_reached, created_at")
      .gte("created_at", new Date(fromMs).toISOString())
      .lte("created_at", new Date(toMs).toISOString()),
    supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, start_at, created_at, end_at"),
  ]);

  if (callsRes.error || campaignsRes.error) {
    console.error("[dashboard/campaigns] query failed:", callsRes.error ?? campaignsRes.error);
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const rows = computeCampaignTable(
    (callsRes.data ?? []) as unknown as DashCallRow[],
    (campaignsRes.data ?? []) as unknown as DashCampaignRow[],
    now,
    ENDED_IDLE_DAYS,
  );

  return NextResponse.json({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows,
  });
}
