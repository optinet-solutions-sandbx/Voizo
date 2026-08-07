import { NextRequest, NextResponse } from "next/server";
import { listQaPrompts } from "@/lib/qaPromptData";
import { selectReachedUnanalyzedAcrossCampaigns } from "@/lib/qaBatchData";
import { submitCampaignBatch, isEnqueueLimit } from "@/lib/qaBatchSubmit";

/**
 * POST /api/qa-prompt-testing/batch/all  { promptId, fromMs?, toMs? }
 *
 * Manual ALL-CAMPAIGNS bulk analysis: submit an OpenAI batch per campaign for every
 * reached, not-yet-analyzed call (with a transcript) in the [fromMs,toMs) call-date
 * window. Largest campaign first; stops cleanly if OpenAI's enqueued-token cap is hit
 * (the rest stay resubmit-safe — re-run to continue as earlier batches drain).
 */
export const maxDuration = 300;

function crossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function POST(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  let body: { promptId?: unknown; fromMs?: unknown; toMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const promptId = typeof body.promptId === "string" ? body.promptId : "";
  const fromMs = typeof body.fromMs === "number" && body.fromMs > 0 ? body.fromMs : null;
  const toMs = typeof body.toMs === "number" && body.toMs > 0 ? body.toMs : null;
  if (!promptId) return NextResponse.json({ error: "promptId is required" }, { status: 400 });

  const prompt = (await listQaPrompts()).find((p) => p.id === promptId);
  if (!prompt) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });

  let byCampaign: Map<string, { id: string; transcript: string }[]>;
  try {
    byCampaign = await selectReachedUnanalyzedAcrossCampaigns({ promptId, fromMs, toMs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to select calls" }, { status: 500 });
  }
  const order = [...byCampaign.entries()].sort((a, b) => b[1].length - a[1].length);
  const totalCalls = order.reduce((s, [, c]) => s + c.length, 0);
  if (totalCalls === 0) {
    return NextResponse.json({ message: "No reached, un-analyzed calls in this window.", submittedBatches: 0, submittedCalls: 0, deferredCampaigns: 0 });
  }

  let submittedBatches = 0;
  let submittedCalls = 0;
  let deferredCampaigns = 0;
  let stop = false;
  let stopReason: string | null = null;

  for (const [campaignId, calls] of order) {
    if (stop) {
      deferredCampaigns++;
      continue;
    }
    try {
      await submitCampaignBatch({ campaignId, calls, promptId, promptTitle: prompt.title, promptContent: prompt.content, apiKey });
      submittedBatches++;
      submittedCalls += calls.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "submit failed";
      if (isEnqueueLimit(msg)) {
        stop = true;
        stopReason = msg;
        deferredCampaigns++;
      }
      // non-limit errors: skip this campaign (it stays resubmit-safe), continue.
    }
  }

  return NextResponse.json({
    submittedBatches,
    submittedCalls,
    totalCalls,
    deferredCampaigns,
    ...(stopReason && { note: `OpenAI batch queue is full — remaining campaigns deferred. Re-run once these drain. (${stopReason.slice(0, 120)})` }),
  });
}
