import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { getQaCallDetail } from "@/lib/qaPromptData";
import { numberTranscript } from "@/lib/qaTranscript";

/**
 * POST /api/qa-prompt-testing/run
 *
 * Run one QA prompt against one call's transcript and return the raw model
 * output (analysisText) — the tester renders it as a structured table (JSON) or
 * plain text. This is the "test a prompt" action: nothing is persisted.
 *
 * Body: { callId: string, promptContent: string }.
 * The transcript is read SERVER-SIDE from the call id (never trusted from the
 * client) so the operator always scores the real, stored transcript.
 *
 * Cost: one gpt-5.4-mini completion per run — on the operator's manual click,
 * off every call/dial path. Same model family as the lab tools.
 */

export const maxDuration = 60;

const MODEL = "gpt-5.4-mini";

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

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
  }

  let body: { callId?: unknown; promptContent?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const callId = typeof body.callId === "string" ? body.callId : "";
  const promptContent = typeof body.promptContent === "string" ? body.promptContent : "";
  if (!callId) return NextResponse.json({ error: "callId is required" }, { status: 400 });
  if (!promptContent.trim()) return NextResponse.json({ error: "promptContent is required" }, { status: 400 });

  let call;
  try {
    call = await getQaCallDetail(callId);
  } catch (err) {
    console.error("[qa-prompt-testing/run] call lookup failed:", err);
    return NextResponse.json({ error: "Failed to load call" }, { status: 500 });
  }
  if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });
  if (!call.transcript.trim()) {
    return NextResponse.json({ error: "This call has no transcript to score" }, { status: 400 });
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 55_000, maxRetries: 1 });
  try {
    const params: Record<string, unknown> = {
      model: MODEL,
      messages: [
        { role: "system", content: promptContent },
        { role: "user", content: `Score this call transcript:\n\n${numberTranscript(call.transcript)}` },
      ],
      max_completion_tokens: 4096,
      // Deterministic: without this a re-run can flip a borderline call's category
      // (Neutral <-> Early Hang-up). temperature 0 + a fixed seed pin the output.
      temperature: 0,
      seed: 7,
    };
    const completion = await openai.chat.completions.create(
      params as unknown as Parameters<typeof openai.chat.completions.create>[0],
    );
    const analysisText =
      (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "";
    if (!analysisText.trim()) {
      return NextResponse.json({ error: "The model returned an empty response" }, { status: 502 });
    }
    return NextResponse.json({ analysisText, model: MODEL });
  } catch (err) {
    console.error("[qa-prompt-testing/run] OpenAI call failed:", err);
    const msg = err instanceof Error ? err.message : "Analysis failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
