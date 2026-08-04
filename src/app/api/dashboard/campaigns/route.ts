import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  computeCampaignTableFromRollup,
  FINISHED_IDLE_DAYS,
  type CallRollupRow,
  type DashCampaignRow,
  type SmsRollupRow,
} from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/campaigns?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Rows for the Campaign Performance table (Val's spec). This table has its OWN date
 * range — independent of the global filter bar. Returns ALL live (non-ghost, non-test)
 * campaigns, including zero-call ones, each with a derived DISPLAY status
 * (running / paused / finished — paused-but-idle, past end_at, or never-run all read as
 * "Finished"; presentation-only, idle window = FINISHED_IDLE_DAYS). Read-only; lenient origin.
 *
 * VOZ-283 (2026-08-04): numbers now come from the dashboard_call_rollup /
 * dashboard_sms_rollup Postgres functions instead of paging every calls_v2 /
 * sms_messages_v2 row through JS (the incident's 31k-row days made that fetch
 * ~47k rows / ~16MB per load). Byte-parity with the old path is proven by
 * src/lib/dashboardRollup.parity.test.ts (run against live prod data) — the
 * response JSON shape is unchanged. The roster fetch stays (players = lifetime
 * campaign_numbers count) but slims to two columns; declined outcomes are now
 * classified inside the SQL, so `outcome` is no longer fetched.
 */
const MS_PER_DAY = 86_400_000;

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

  // Rollups are campaign-LIFETIME ([epoch, now]) — matching the old route, where
  // Attempts/Reached were lifetime totals and from/to only echo in the response
  // (the date picker filters WHICH campaigns list client-side, not the numbers).
  const [callRollupRes, smsRollupRes, campaigns, numbers] = await Promise.all([
    supabaseAdmin.rpc("dashboard_call_rollup", {
      p_start: new Date(0).toISOString(),
      p_end: new Date(now).toISOString(),
    }),
    supabaseAdmin.rpc("dashboard_sms_rollup", {
      p_start: new Date(0).toISOString(),
      p_end: new Date(now).toISOString(),
    }),
    // fetchAllRows pages past PostgREST's 1000-row cap — campaigns_v2 grows
    // daily (recurring day-children); a bare .select() clamps at 1000 with no
    // stable order, so table rows would vanish arbitrarily past the cap.
    fetchAllRows(
      supabaseAdmin,
      "campaigns_v2",
      // cio_workspace: the per-row brand chip (VOZ-216).
      "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at",
      "id",
    ),
    // Players (full roster count) is campaign-LIFETIME; two columns only.
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "id, campaign_id", "id"),
  ]);

  if (callRollupRes.error || smsRollupRes.error) {
    console.error(
      "[dashboard/campaigns] query failed:",
      callRollupRes.error ?? smsRollupRes.error,
    );
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const playersByCampaign = new Map<string, number>();
  for (const n of numbers as Array<{ campaign_id: string }>) {
    playersByCampaign.set(n.campaign_id, (playersByCampaign.get(n.campaign_id) ?? 0) + 1);
  }

  const rows = computeCampaignTableFromRollup(
    (callRollupRes.data ?? []) as CallRollupRow[],
    (smsRollupRes.data ?? []) as SmsRollupRow[],
    campaigns as unknown as DashCampaignRow[],
    now,
    FINISHED_IDLE_DAYS,
    playersByCampaign,
  );

  return NextResponse.json({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows,
  });
}
