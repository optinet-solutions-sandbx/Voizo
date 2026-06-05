import { NextRequest, NextResponse } from "next/server";
import { selectUnscoredCalls, upsertQaScore, countScoresToday } from "@/lib/qaScoreData";
import { scoreTranscript } from "@/lib/qa/scoreCall";
import { judgeVersion } from "@/lib/qa/judgePrompt";
import {
  qaJudgeReady,
  QA_JUDGE_MODEL,
  QA_ROW_CAP,
  QA_CONCURRENCY,
  QA_MAX_SCORES_PER_DAY,
} from "@/lib/qa/qaConfig";

export const maxDuration = 60;

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
 * POST /api/qa/campaign/[campaignId]/grade — on-demand "grade all" for one campaign.
 * Origin-checked + flag-gated + service-role.
 *
 * Scores only the campaign's UNSCORED real conversations:
 *   - selectUnscoredCalls already excludes voicemails (hasRealConversation) + already-scored rows;
 *   - scoreTranscript additionally skips <30s + any voicemail BEFORE the API call,
 * so verified voicemails / short calls cost nothing. (A machine fragment that slips
 * keyword-detection still gets judged — it comes back `unsure`, which is correct + cheap.)
 *
 * Bounded by ROW_CAP per click + the daily cap + concurrency.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ campaignId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  if (!qaJudgeReady()) return NextResponse.json({ error: "QA judge disabled" }, { status: 503 });

  const { campaignId } = await ctx.params;
  const jv = judgeVersion(QA_JUDGE_MODEL);

  const already = await countScoresToday();
  const budget = Math.max(0, QA_MAX_SCORES_PER_DAY - already);
  if (budget === 0) {
    return NextResponse.json({ judge_version: jv, candidates: 0, scored: 0, skipped: 0, capped: true });
  }

  const cap = Math.min(QA_ROW_CAP, budget);
  const candidates = await selectUnscoredCalls(jv, cap, campaignId);

  let scored = 0;
  const skipReasons: Record<string, number> = {};
  for (let i = 0; i < candidates.length; i += QA_CONCURRENCY) {
    const chunk = candidates.slice(i, i + QA_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (c) => {
        const r = await scoreTranscript(
          { transcript: c.transcript, durationSeconds: c.durationSeconds },
          { model: QA_JUDGE_MODEL },
        );
        if (!r.ok) return r.skipped;
        const up = await upsertQaScore({
          callId: c.id,
          campaignId: c.campaignId,
          createdAt: c.createdAt,
          verdict: r.verdict,
          goalReachedAtScore: c.goalReached,
          judgeModel: r.judgeModel,
          judgeVersion: r.judgeVersion,
          meta: r.meta,
        });
        return up.ok ? null : "write-failed";
      }),
    );
    for (const res of results) {
      if (res === null) scored++;
      else skipReasons[res] = (skipReasons[res] ?? 0) + 1;
    }
  }

  return NextResponse.json({
    judge_version: jv,
    candidates: candidates.length,
    scored,
    skipped: candidates.length - scored,
    skipReasons,
  });
}
