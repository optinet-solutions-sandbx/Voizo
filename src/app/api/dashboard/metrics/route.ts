import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET /api/dashboard/metrics
 *
 * Read-only aggregated metrics for the home dashboard (Material Admin layout).
 * Returns:
 *   - callsToday / callsYesterday        (UTC-day counts; for the +/- delta on the Calls Today card)
 *   - connectRate7d + connectRate7dPrior (rolling 7-day windows; prior is 7-14d ago, for delta)
 *   - goalRate7d + goalRate7dPrior       (same window scheme)
 *   - series30d                           (30 daily {day, calls, goals} for the hero chart)
 *   - recent                              (top 6 campaigns by last call activity, with per-campaign rates)
 *
 * Definitions:
 *   connected = calls_v2.status IN ('answered','completed')
 *   goal      = calls_v2.goal_reached = true
 *
 * Day buckets are UTC for v1 — labels in the UI implicitly mean "today UTC".
 * Local-timezone bucketing is a follow-up polish.
 *
 * No side effects. Two Supabase queries (calls_v2 last 30d + campaigns_v2 list)
 * aggregated in JS. At current PoC volume (~hundreds of calls/day) this stays
 * well under any sensible payload limit.
 *
 * CSRF/origin policy: read-only, lenient on missing Origin (see
 * feedback_csrf_origin_check_get_lenient).
 */

const WINDOW_DAYS_LONG = 30;
const WINDOW_DAYS_SHORT = 7;
const MS_PER_DAY = 86_400_000;

const CONNECTED_STATUSES = new Set(["answered", "completed"]);

interface CallRow {
  created_at: string;
  status: string;
  goal_reached: boolean | null;
  campaign_id: string;
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  timezone: string;
  vapi_assistant_name: string | null;
  source: string | null;
}

function utcDayString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function GET(request: NextRequest) {
  // Lenient origin check (GET — same policy as /api/workers/state).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const now = new Date();
  const fetchedAt = now.toISOString();
  const nowMs = now.getTime();

  const longCutoffIso = new Date(nowMs - WINDOW_DAYS_LONG * MS_PER_DAY).toISOString();

  // Pull 30d window of calls + the campaign list in parallel.
  const [callsRes, campaignsRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select("created_at, status, goal_reached, campaign_id")
      .gte("created_at", longCutoffIso),
    supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, status, timezone, vapi_assistant_name, source"),
  ]);

  if (callsRes.error) {
    console.error("[dashboard/metrics] calls_v2 query failed:", callsRes.error);
    return NextResponse.json({ error: "Failed to read calls" }, { status: 500 });
  }
  if (campaignsRes.error) {
    console.error("[dashboard/metrics] campaigns_v2 query failed:", campaignsRes.error);
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const calls = (callsRes.data ?? []) as unknown as CallRow[];
  const campaignsList = (campaignsRes.data ?? []) as unknown as CampaignRow[];

  // Segregation: internal GhostPortal runs (source='ghost_portal', either tier)
  // must never appear in client-facing dashboard KPIs or the recent list. Filter
  // them from BOTH the calls aggregation and the campaign list. (Only ghost is
  // excluded — non-ghost test campaigns are unchanged; that's a separate concern.)
  const ghostCampaignIds = new Set(
    campaignsList.filter((c) => c.source === "ghost_portal").map((c) => c.id),
  );

  // Window boundaries.
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterdayStartMs = todayStartMs - MS_PER_DAY;
  const cutoff7dMs = nowMs - WINDOW_DAYS_SHORT * MS_PER_DAY;
  const cutoff14dMs = nowMs - 2 * WINDOW_DAYS_SHORT * MS_PER_DAY;

  let callsToday = 0;
  let callsYesterday = 0;

  let connected7d = 0, total7d = 0, goals7d = 0;
  let connected7dPrior = 0, total7dPrior = 0, goals7dPrior = 0;

  const dayBuckets = new Map<string, { calls: number; goals: number }>();
  const perCampaign = new Map<string, { calls: number; connected: number; goals: number; lastAtMs: number }>();

  for (const c of calls) {
    if (ghostCampaignIds.has(c.campaign_id)) continue; // segregate ghost from all KPIs
    const tMs = new Date(c.created_at).getTime();
    const dayKey = utcDayString(new Date(c.created_at));
    const isConnected = CONNECTED_STATUSES.has(c.status);
    const isGoal = c.goal_reached === true;

    // Hero-chart 30d buckets
    const b = dayBuckets.get(dayKey) ?? { calls: 0, goals: 0 };
    b.calls += 1;
    if (isGoal) b.goals += 1;
    dayBuckets.set(dayKey, b);

    // Today / yesterday counts
    if (tMs >= todayStartMs) callsToday += 1;
    else if (tMs >= yesterdayStartMs) callsYesterday += 1;

    // 7d / 7d-prior rate windows
    if (tMs >= cutoff7dMs) {
      total7d += 1;
      if (isConnected) connected7d += 1;
      if (isGoal) goals7d += 1;
    } else if (tMs >= cutoff14dMs) {
      total7dPrior += 1;
      if (isConnected) connected7dPrior += 1;
      if (isGoal) goals7dPrior += 1;
    }

    // Per-campaign roll-up (30d total)
    const agg = perCampaign.get(c.campaign_id) ?? { calls: 0, connected: 0, goals: 0, lastAtMs: 0 };
    agg.calls += 1;
    if (isConnected) agg.connected += 1;
    if (isGoal) agg.goals += 1;
    if (tMs > agg.lastAtMs) agg.lastAtMs = tMs;
    perCampaign.set(c.campaign_id, agg);
  }

  // Build 30d series — zero-fill missing days so the chart x-axis stays even.
  const series30d: Array<{ day: string; calls: number; goals: number }> = [];
  for (let i = WINDOW_DAYS_LONG - 1; i >= 0; i--) {
    const d = new Date(nowMs - i * MS_PER_DAY);
    const key = utcDayString(d);
    const b = dayBuckets.get(key);
    series30d.push({ day: key, calls: b?.calls ?? 0, goals: b?.goals ?? 0 });
  }

  // Recent campaigns — sort by last call activity (campaigns with no calls land last).
  const recent = campaignsList
    .filter((c) => c.source !== "ghost_portal") // ghost runs never surface in the client recent list
    .map((c) => {
      const agg = perCampaign.get(c.id);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        timezone: c.timezone,
        vapi_assistant_name: c.vapi_assistant_name,
        total_calls_30d: agg?.calls ?? 0,
        connect_rate_30d: agg && agg.calls > 0 ? agg.connected / agg.calls : 0,
        success_rate_30d: agg && agg.calls > 0 ? agg.goals / agg.calls : 0,
        last_call_at: agg && agg.lastAtMs > 0 ? new Date(agg.lastAtMs).toISOString() : null,
      };
    })
    .sort((a, b) => {
      const aT = a.last_call_at ? new Date(a.last_call_at).getTime() : 0;
      const bT = b.last_call_at ? new Date(b.last_call_at).getTime() : 0;
      return bT - aT;
    })
    .slice(0, 6);

  return NextResponse.json({
    fetchedAt,
    callsToday,
    callsYesterday,
    connectRate7d: total7d > 0 ? connected7d / total7d : 0,
    connectRate7dPrior: total7dPrior > 0 ? connected7dPrior / total7dPrior : 0,
    goalRate7d: total7d > 0 ? goals7d / total7d : 0,
    goalRate7dPrior: total7dPrior > 0 ? goals7dPrior / total7dPrior : 0,
    series30d,
    recent,
  });
}
