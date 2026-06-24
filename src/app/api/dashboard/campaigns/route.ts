import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { computeCampaignTable, type DashCallRow, type DashCampaignRow, type DashSmsRow } from "@/lib/dashboardAnalytics";

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

  const [calls, campaignsRes, numbers, sms] = await Promise.all([
    // Attempts/Reached are campaign-LIFETIME totals (NOT windowed) so the row metrics match the
    // expanded breakdown. fetchAllRows pages past PostgREST's 1000-row cap (lifetime calls exceed
    // it). The from/to params are NOT applied here — they only echo in the response + the date
    // picker filters WHICH campaigns are listed (client-side, by activity), not the per-row numbers.
    fetchAllRows(supabaseAdmin, "calls_v2", "campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail", "id"),
    supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, start_at, created_at, end_at"),
    // Players (full roster) + SMS sent are also campaign-LIFETIME totals: the roster has no "last
    // 30 days", and texts-sent reads as a campaign total. fetchAllRows pages past the 1000-row cap.
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "campaign_id", "id"),
    fetchAllRows(supabaseAdmin, "sms_messages_v2", "campaign_id, status", "id"),
  ]);

  if (campaignsRes.error) {
    console.error("[dashboard/campaigns] query failed:", campaignsRes.error);
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const rows = computeCampaignTable(
    calls as unknown as DashCallRow[],
    (campaignsRes.data ?? []) as unknown as DashCampaignRow[],
    now,
    ENDED_IDLE_DAYS,
    numbers as unknown as Array<{ campaign_id: string }>,
    sms as unknown as DashSmsRow[],
  );

  return NextResponse.json({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows,
  });
}
