import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { listQaPrompts } from "@/lib/qaPromptData";
import { getQaSchedule, setQaSchedule, selectReachedUnanalyzedAcrossCampaigns } from "@/lib/qaBatchData";
import { submitCampaignBatch, importCompletedBatches, isEnqueueLimit } from "@/lib/qaBatchSubmit";

/**
 * GET /api/cron/qa-analysis-daily — Vercel Cron (see vercel.json).
 *
 * Two jobs each run:
 *   1) Import sweep — pull in any batches that completed since the last run.
 *   2) If the daily schedule is ENABLED, submit an OpenAI batch per campaign for every
 *      reached, not-yet-analyzed call from the last ~2 days (48h lookback so late-arriving
 *      transcripts are caught; already-analyzed calls are skipped, so nothing double-charges).
 *
 * OFF by default (listener_qa_schedule.enabled=false) — enabling starts standing daily spend.
 */
export const maxDuration = 300;

const LOOKBACK_MS = 2 * 86_400_000; // 48h — a full "yesterday" plus stragglers

function authorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  const expected = `Bearer ${cronSecret}`;
  const received = request.headers.get("authorization") || "";
  return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export async function GET(request: NextRequest) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "Not configured" }, { status: 500 });
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  // 1) Import anything that finished since last run.
  let imported = { imported: 0, completed: 0, active: 0 };
  try {
    imported = await importCompletedBatches(apiKey);
  } catch (e) {
    console.error("[qa-analysis-daily] import sweep failed:", e);
  }

  // 2) Submit yesterday's calls if the schedule is on.
  const schedule = await getQaSchedule();
  if (!schedule.enabled || !schedule.promptId) {
    console.log(`[qa-analysis-daily] schedule disabled — import-only (imported=${imported.imported}, active=${imported.active})`);
    return NextResponse.json({ scheduled: false, ...imported });
  }

  const prompt = (await listQaPrompts()).find((p) => p.id === schedule.promptId);
  if (!prompt) {
    console.warn("[qa-analysis-daily] scheduled prompt no longer exists — skipping submit");
    return NextResponse.json({ scheduled: true, submitError: "prompt-missing", ...imported });
  }

  const toMs = Date.now();
  const fromMs = toMs - LOOKBACK_MS;
  const byCampaign = await selectReachedUnanalyzedAcrossCampaigns({ promptId: prompt.id, fromMs, toMs });
  const order = [...byCampaign.entries()].sort((a, b) => b[1].length - a[1].length);

  let submittedBatches = 0;
  let submittedCalls = 0;
  let deferred = 0;
  let stop = false;
  for (const [campaignId, calls] of order) {
    if (stop) { deferred++; continue; }
    try {
      await submitCampaignBatch({ campaignId, calls, promptId: prompt.id, promptTitle: prompt.title, promptContent: prompt.content, apiKey });
      submittedBatches++;
      submittedCalls += calls.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "submit failed";
      if (isEnqueueLimit(msg)) { stop = true; deferred++; }
      else console.error(`[qa-analysis-daily] submit failed for ${campaignId}:`, msg);
    }
  }

  const summary = `${submittedBatches} batches / ${submittedCalls} calls${deferred ? `, ${deferred} deferred (queue full)` : ""}; imported ${imported.imported}`;
  await setQaSchedule({ lastRunAt: new Date().toISOString(), lastRunSummary: summary });
  console.log(`[qa-analysis-daily] ${summary}`);
  return NextResponse.json({ scheduled: true, submittedBatches, submittedCalls, deferred, ...imported });
}
