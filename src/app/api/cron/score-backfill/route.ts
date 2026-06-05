import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { CRON_NAMES, recordHeartbeat } from "@/lib/alerts/slack";
import { scoreTranscript } from "@/lib/qa/scoreCall";
import { selectUnscoredCalls, upsertQaScore, countScoresToday } from "@/lib/qaScoreData";
import { judgeVersion } from "@/lib/qa/judgePrompt";
import {
  qaJudgeReady,
  QA_JUDGE_MODEL,
  QA_ROW_CAP,
  QA_CONCURRENCY,
  QA_MAX_SCORES_PER_DAY,
} from "@/lib/qa/qaConfig";
import crypto from "crypto";

export const maxDuration = 60; // judge calls are ~1-3s each; bounded by ROW_CAP/concurrency

/**
 * GET /api/cron/score-backfill — Vercel Cron, every 30 min (see vercel.json).
 * OUT-OF-BAND QA judge. NEVER the end-of-call webhook (that path dispatches SMS).
 * Flag-gated: no-ops until QA_JUDGE_ENABLED=true AND ANTHROPIC_API_KEY set.
 * Cost (CLAUDE.md #4): ~sub-cent/call (SPEC); ROW_CAP + daily cap + idempotent select bound it.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[score-backfill] CRON_SECRET not set");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  const expected = `Bearer ${cronSecret}`;
  const received = request.headers.get("authorization") || "";
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!qaJudgeReady()) {
    console.log("[score-backfill] disabled (QA_JUDGE_ENABLED off or no ANTHROPIC_API_KEY) — no-op");
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.scoreBackfill);
    return NextResponse.json({ disabled: true });
  }

  const jv = judgeVersion(QA_JUDGE_MODEL);
  const already = await countScoresToday();
  if (already >= QA_MAX_SCORES_PER_DAY) {
    console.warn(`[score-backfill] daily cap reached (${already}/${QA_MAX_SCORES_PER_DAY}) — skipping`);
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.scoreBackfill);
    return NextResponse.json({ capped: true, already });
  }

  const budget = Math.max(0, QA_MAX_SCORES_PER_DAY - already);
  const candidates = await selectUnscoredCalls(jv, Math.min(QA_ROW_CAP, budget));
  let scored = 0;
  let skipped = 0;
  for (let i = 0; i < candidates.length; i += QA_CONCURRENCY) {
    const chunk = candidates.slice(i, i + QA_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (c) => {
        const r = await scoreTranscript(
          { transcript: c.transcript, durationSeconds: c.durationSeconds },
          { model: QA_JUDGE_MODEL },
        );
        if (!r.ok) return false;
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
        return up.ok;
      }),
    );
    for (const ok of results) ok ? scored++ : skipped++;
  }

  console.log(
    `[score-backfill] judge_version=${jv} candidates=${candidates.length} scored=${scored} skipped=${skipped}`,
  );
  await recordHeartbeat(supabaseAdmin, CRON_NAMES.scoreBackfill);
  return NextResponse.json({ judge_version: jv, candidates: candidates.length, scored, skipped });
}
