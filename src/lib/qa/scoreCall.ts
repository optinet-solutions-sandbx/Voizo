// src/lib/qa/scoreCall.ts
// Best-effort, NEVER-throws single-transcript scorer. Guards BEFORE the API call
// (cheap skips), truncates, calls Claude, parses. Off the call/dial path entirely.
import Anthropic from "@anthropic-ai/sdk";
import { isVoicemail, hasRealConversation } from "../transcriptClassify";
import {
  ANTHROPIC_API_KEY,
  QA_JUDGE_MODEL,
  QA_MAX_OUTPUT_TOKENS,
  QA_TRANSCRIPT_CHAR_CAP,
  QA_MIN_DURATION_SECONDS,
} from "./qaConfig";
import {
  judgeSystemText,
  buildUserMessage,
  parseVerdict,
  judgeVersion,
  type JudgeVerdict,
} from "./judgePrompt";

export interface ScoreInput {
  transcript: string;
  durationSeconds?: number | null;
}
export type ScoreSkip =
  | "not-ready"
  | "voicemail"
  | "no-conversation"
  | "too-short"
  | "empty"
  | "api-error"
  | "unparsable";
export type ScoreResult =
  | { ok: true; verdict: JudgeVerdict; judgeModel: string; judgeVersion: string; meta: Record<string, unknown> }
  | { ok: false; skipped: ScoreSkip };

// Minimal shape we depend on — lets tests inject a fake and keeps SDK swaps cheap.
export interface JudgeClient {
  messages: { create(args: unknown): Promise<{ content: Array<{ type: string; text?: string }> }> };
}

let _client: JudgeClient | null = null;
/** Lazily build the real Anthropic client. Returns null when no key (flag-OFF safe). */
export function getAnthropicClient(): JudgeClient | null {
  if (!ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY }) as unknown as JudgeClient;
  return _client;
}

interface ScoreOpts {
  client?: JudgeClient | null;
  model?: string;
  minDurationSeconds?: number;
}

export async function scoreTranscript(input: ScoreInput, opts: ScoreOpts = {}): Promise<ScoreResult> {
  const model = opts.model ?? QA_JUDGE_MODEL;
  const minDur = opts.minDurationSeconds ?? QA_MIN_DURATION_SECONDS;
  const t = (input.transcript ?? "").trim();

  // ── Cheap guards BEFORE any API spend ──
  if (!t) return { ok: false, skipped: "empty" };
  if (isVoicemail(t)) return { ok: false, skipped: "voicemail" };
  if (!hasRealConversation(t)) return { ok: false, skipped: "no-conversation" };
  if (typeof input.durationSeconds === "number" && input.durationSeconds < minDur)
    return { ok: false, skipped: "too-short" };

  const client = opts.client ?? getAnthropicClient();
  if (!client) return { ok: false, skipped: "not-ready" };

  const transcript = t.slice(0, QA_TRANSCRIPT_CHAR_CAP);
  let text: string;
  try {
    const resp = await client.messages.create({
      model,
      max_tokens: QA_MAX_OUTPUT_TOKENS,
      system: [{ type: "text", text: judgeSystemText(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildUserMessage(transcript) }],
    });
    text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n");
  } catch {
    return { ok: false, skipped: "api-error" }; // 429/5xx/network — row stays unscored, retried next tick
  }

  const verdict = parseVerdict(text);
  if (!verdict) return { ok: false, skipped: "unparsable" };
  return {
    ok: true,
    verdict,
    judgeModel: model,
    judgeVersion: judgeVersion(model),
    meta: { len: transcript.length },
  };
}
