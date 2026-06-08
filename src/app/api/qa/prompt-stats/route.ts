import { NextRequest, NextResponse } from "next/server";
import { selectScoresForPromptStats } from "@/lib/qa/goldenSetData";
import { computePromptVersionStats } from "@/lib/qa/goldenSetMath";
import { qaJudgeReady } from "@/lib/qa/qaConfig";

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * GET /api/qa/prompt-stats?campaignId= — the "v7 vs v6" readout: judge success-rate
 * per prompt_version_id across PRODUCTION qa_scores (rigorous attribution only —
 * single|time_window; unsure excluded from the rate). prompt_versions are
 * campaign-keyed, so a meaningful comparison is normally scoped to one campaignId.
 * Behind Basic-Auth (middleware) + origin-checked; service role.
 */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });

  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId") || undefined;

  try {
    const rows = await selectScoresForPromptStats(campaignId);
    const stats = computePromptVersionStats(rows);
    // judgeEnabled lets the UI tell "no scores yet / judge off" apart from a real empty result.
    return NextResponse.json({ campaignId: campaignId ?? null, judgeEnabled: qaJudgeReady(), stats });
  } catch (err) {
    console.error(`[golden/prompt-stats] ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Failed to load prompt stats" }, { status: 500 });
  }
}
