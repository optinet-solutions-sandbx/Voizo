import { NextRequest, NextResponse } from "next/server";
import { readCalibration, selectCampaignScores } from "@/lib/qaScoreData";
import { computeCalibration } from "@/lib/qa/qaScoreMath";
import { judgeVersion } from "@/lib/qa/judgePrompt";
import { qaJudgeReady, QA_JUDGE_MODEL } from "@/lib/qa/qaConfig";

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
 * GET /api/qa/campaign/[campaignId] — judge data for the Reviews drill-down:
 * status + per-call verdicts + judge-vs-human calibration for this campaign.
 * Origin-checked, behind the Basic-Auth middleware, service-role. Returns OFF/empty
 * gracefully when the judge is off or qa_scores doesn't exist yet.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ campaignId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const { campaignId } = await ctx.params;
  const jv = judgeVersion(QA_JUDGE_MODEL);

  const [scoreRows, calRows] = await Promise.all([
    selectCampaignScores(campaignId, jv),
    readCalibration(jv, campaignId),
  ]);

  const calibration = computeCalibration(
    calRows.map((r) => ({
      call_id: r.call_id as string,
      success_verdict: (r.success_verdict as string | null) ?? null,
      human_success: (r.human_success as string | null) ?? null,
    })),
  );

  const scores: Record<
    string,
    { verdict: string | null; confidence: number | null; path: string | null; rationale: string | null; judgeVersion: string }
  > = {};
  for (const s of scoreRows) {
    scores[s.callId] = {
      verdict: s.verdict,
      confidence: s.confidence,
      path: s.path,
      rationale: s.rationale,
      judgeVersion: s.judgeVersion,
    };
  }

  return NextResponse.json({ judgeEnabled: qaJudgeReady(), judge_version: jv, calibration, scores });
}
