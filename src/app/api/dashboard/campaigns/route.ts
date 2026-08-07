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
 * response JSON shape is unchanged. Declined outcomes are now classified inside
 * the SQL, so `outcome` is no longer fetched.
 *
 * 2026-08-05: `players` also moved into SQL (campaign_roster_counts). VOZ-283 left
 * the roster as a full-table fetchAllRows purely to COUNT rows in JS — 27 sequential
 * round-trips at 26.6k rows, which turned out to BE this route's latency (measured
 * 15.5-16.8s, vs 0.9-1.4s for /api/qa-prompt-testing/campaigns running the same
 * lifetime dashboard_call_rollup without that leg). The lifetime rollup scan was
 * never the bottleneck; round-trip count was. See 2026-08-05_campaign_roster_counts_rpc.sql.
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
  const [callRollupRes, smsRollupRes, campaigns, rosterRes] = await Promise.all([
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
      // script_id/script_name/segment_id: the section filters + mass export (Val 2026-08-07).
      "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at, script_id, script_name, segment_id",
      "id",
    ),
    // Players (full roster count) is campaign-LIFETIME. Counted in SQL: paging the
    // whole table to count rows in JS was 27 sequential round-trips (26.6k rows) and
    // WAS this route's wall clock — 15.5-16.8s prod, vs 0.9-1.4s for the same
    // lifetime rollup without this leg. One GROUP BY, one round-trip.
    supabaseAdmin.rpc("campaign_roster_counts"),
  ]);

  if (callRollupRes.error || smsRollupRes.error || rosterRes.error) {
    console.error(
      "[dashboard/campaigns] query failed:",
      callRollupRes.error ?? smsRollupRes.error ?? rosterRes.error,
    );
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const playersByCampaign = new Map<string, number>();
  for (const r of (rosterRes.data ?? []) as Array<{ campaign_id: string; players: number }>) {
    playersByCampaign.set(r.campaign_id, Number(r.players) || 0);
  }

  const rows = computeCampaignTableFromRollup(
    (callRollupRes.data ?? []) as CallRollupRow[],
    (smsRollupRes.data ?? []) as SmsRollupRow[],
    campaigns as unknown as DashCampaignRow[],
    now,
    FINISHED_IDLE_DAYS,
    playersByCampaign,
  );

  // Ghost/test campaigns never surface in rows; strip their rollup rows too so
  // the client-side summary can't count what the table refuses to list.
  const liveIds = new Set(rows.map((r) => r.id));
  const callRollup = ((callRollupRes.data ?? []) as CallRollupRow[]).filter((r) => liveIds.has(r.campaign_id));
  const smsRollup = ((smsRollupRes.data ?? []) as SmsRollupRow[]).filter((r) => liveIds.has(r.campaign_id));

  return NextResponse.json({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows,
    // Day-grain rollup rows (already fetched for the table sums above — this
    // reuses, not re-queries). The client windows/sums these per the ACTIVE
    // filters for the section summary block + mass export (Val 2026-08-07),
    // so summary === sum of listed rows by construction.
    rollup: { calls: callRollup, sms: smsRollup },
  });
}
