import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { scoreTranscript } from "@/lib/qa/scoreCall";
import { upsertQaScore } from "@/lib/qaScoreData";
import { judgeVersion } from "@/lib/qa/judgePrompt";
import { qaJudgeReady, QA_JUDGE_MODEL } from "@/lib/qa/qaConfig";

export const maxDuration = 60;

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return true; // server-to-server / same-origin fetch
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
const txt = (t: unknown): string =>
  typeof t === "string"
    ? t
    : t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string"
    ? (t as { text: string }).text
    : "";

/**
 * POST /api/qa/score/[callId] — on-demand single-call (re)score from /reviews.
 * Origin-checked + flag-gated + service-role. Honors the no-rescore guard unless
 * ?force=true. Scores exactly ONE call — never "score everything".
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ callId: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  if (!qaJudgeReady()) return NextResponse.json({ error: "QA judge disabled" }, { status: 503 });

  const { callId } = await ctx.params;
  const { searchParams } = new URL(request.url);
  const force = searchParams.get("force") === "true";
  const jv = judgeVersion(QA_JUDGE_MODEL);

  const { data: call, error } = await supabaseAdmin
    .from("calls_v2")
    .select("id, campaign_id, created_at, duration_seconds, goal_reached, transcript")
    .eq("id", callId)
    .maybeSingle();
  if (error || !call) return NextResponse.json({ error: "Call not found" }, { status: 404 });

  if (!force) {
    const { data: existing } = await supabaseAdmin
      .from("qa_scores")
      .select("id")
      .eq("call_id", callId)
      .eq("judge_version", jv)
      .limit(1);
    if (existing && existing.length)
      return NextResponse.json({ callId, skipped: "already-scored", judge_version: jv });
  }

  const r = await scoreTranscript(
    { transcript: txt(call.transcript), durationSeconds: call.duration_seconds as number | null },
    { model: QA_JUDGE_MODEL },
  );
  if (!r.ok) return NextResponse.json({ callId, skipped: r.skipped, judge_version: jv });
  const up = await upsertQaScore({
    callId: call.id as string,
    campaignId: call.campaign_id as string,
    createdAt: call.created_at as string,
    verdict: r.verdict,
    goalReachedAtScore: (call.goal_reached as boolean | null) ?? null,
    judgeModel: r.judgeModel,
    judgeVersion: r.judgeVersion,
    meta: r.meta,
  });
  return NextResponse.json({ callId, ok: up.ok, verdict: r.verdict, judge_version: jv });
}
