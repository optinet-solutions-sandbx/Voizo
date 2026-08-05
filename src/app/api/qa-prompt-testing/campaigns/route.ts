import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

/**
 * GET /api/qa-prompt-testing/campaigns
 *
 * Fast campaign list for the QA Prompt Testing landing. Uses the dashboard_call_rollup
 * Postgres function (VOZ-283) for per-campaign counts instead of the reviews path, which
 * paged every calls_v2 transcript through JS to classify it (~30s at 9k transcripts /
 * 52k calls). The rollup aggregates in SQL and returns one small row per campaign-day.
 *
 * Real, non-ghost, non-test campaigns only (the rollup excludes ghost + test in SQL).
 * Per campaign: totalCallCount (attempts) + conversationCount (reach = reached a live
 * person, not voicemail) + goalReachedCount (successful). Read-only; lenient origin.
 */
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
  const [rollup, camps] = await Promise.all([
    supabaseAdmin.rpc("dashboard_call_rollup", {
      p_start: new Date(0).toISOString(),
      p_end: new Date(now).toISOString(),
    }),
    // fetchAllRows: a bare .select() clamps at PostgREST's 1000-row cap with no stable
    // order — campaigns_v2 grows ~9 recurring day-children/day (162 rows 2026-08-05),
    // so campaigns would silently vanish from this list within months.
    fetchAllRows(supabaseAdmin, "campaigns_v2", "id, name, is_test, created_at", "id"),
  ]);

  if (rollup.error) {
    console.error("[qa-prompt-testing/campaigns] rollup failed:", rollup.error);
    return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500 });
  }

  const meta = new Map<string, { name: string | null; isTest: boolean; createdAt: string | null }>();
  for (const c of camps as Array<Record<string, unknown>>) {
    meta.set(c.id as string, {
      name: (c.name as string) ?? null,
      isTest: Boolean(c.is_test),
      createdAt: (c.created_at as string) ?? null,
    });
  }

  const agg = new Map<string, { calls: number; reached: number; goal: number }>();
  for (const r of (rollup.data ?? []) as Array<Record<string, unknown>>) {
    const id = r.campaign_id as string;
    const a = agg.get(id) ?? { calls: 0, reached: 0, goal: 0 };
    a.calls += (r.attempts as number) ?? 0;
    a.reached += (r.reach as number) ?? 0;
    a.goal += (r.successful as number) ?? 0;
    agg.set(id, a);
  }

  const campaigns = [];
  for (const [id, a] of agg) {
    const m = meta.get(id);
    if (!m) continue; // campaign row gone — skip
    campaigns.push({
      campaignId: id,
      campaignName: m.name ?? "—",
      isTest: m.isTest,
      createdAt: m.createdAt ?? new Date(0).toISOString(),
      conversationCount: a.reached, // reached a live person (rollup `reach`)
      totalCallCount: a.calls, // attempts
      goalReachedCount: a.goal, // successful
      labeledCount: 0,
    });
  }

  return NextResponse.json({ campaigns });
}
