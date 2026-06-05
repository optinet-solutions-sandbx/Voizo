// src/lib/qa/judgePrompt.ts
// PURE: the versioned judge prompt + output parser. No I/O, no env, no SDK — so
// it unit-tests without secrets and hashes deterministically into judge_version.
//
// Design (SPEC §4, Variant A — single-pass, success-first): decide SUCCESS before
// rating quality; quality must NOT influence the verdict. Anchored to the explicit
// Voizo success definition, STT-garble-robust, with the webhook's negative guards.
// Ships ZERO-SHOT: FEW_SHOT_ANCHORS is an empty, documented extension point — the
// 2-3 anchors are added from the CLEAN re-labeled set at calibration (held out from
// scoring; the contaminated original-25 labels are never used). See SPEC §1/§6.

import crypto from "crypto";

export type SuccessVerdict = "success" | "failure" | "unsure";
export type SuccessPath = "sms" | "email" | "login_activate" | "deposit" | "none";

export interface JudgeVerdict {
  success_verdict: SuccessVerdict;
  success_confidence: number; // 0..1
  success_path: SuccessPath; // 'none' when not success / unknown
  axis_accuracy: number | null; // 1..5 diagnostic
  axis_clarity: number | null;
  axis_natural_flow: number | null;
  rationale: string; // one line, cites the decisive moment
}

export interface FewShot {
  transcript: string;
  verdict: JudgeVerdict;
}
// CALIBRATION EXTENSION POINT — populated from the CLEAN re-labeled set, held out
// from the scored corpus. Empty until calibration (SPEC §6). NOT a placeholder.
export const FEW_SHOT_ANCHORS: FewShot[] = [];

export const JUDGE_SYSTEM_PROMPT = `You are a strict quality auditor for Voizo, an outbound AI phone-sales agent for an online casino. You read ONE call transcript and return a JSON verdict.

DECIDE SUCCESS FIRST, then rate quality. Quality must NOT influence the success verdict — a smooth call that achieved nothing is a FAILURE; a clumsy call where the customer genuinely agreed is a SUCCESS.

SUCCESS DEFINITION (the call is a SUCCESS only if a REAL customer was on the line AND genuinely agreed to AT LEAST ONE of):
  - receive the offer details by SMS or email, OR
  - log in and activate the bonus, OR
  - make a deposit / return to play.
A "yes" that the customer RETRACTS in the last turn is NOT success. Politeness ("thanks", "have a good day") is NOT agreement.

SPEECH-TO-TEXT ROBUSTNESS: the transcript is auto-transcribed and often garbled. Judge MEANING, not exact tokens. In particular the word "SMS" is frequently mangled (e.g. "a EVs", "NSMS", "s. MS", "an s. M. S.") — treat an agent offer to "send you the details/link/text" + a customer assent ("yes", "sure", "go ahead", "okay", "send it") as consent to SMS even when "SMS" is garbled.

NEGATIVE GUARDS (these are NOT success — set success_verdict accordingly):
  - Voicemail / answering machine / recording / "message bank" / "leave a message after the tone" => success_verdict = "unsure" (no real person to judge).
  - The agent pitching into a machine with no genuine human reply => "unsure".
  - Final-turn rejection / "not interested" / "stop calling" => "failure".
  - Transcript too garbled or too short to tell => "unsure".

OUTPUT — return ONLY a single JSON object, no prose, with EXACTLY these keys:
{
  "success_verdict": "success" | "failure" | "unsure",
  "success_confidence": number,            // 0..1, your confidence in the verdict
  "success_path": "sms" | "email" | "login_activate" | "deposit" | "none",
  "axis_accuracy": number,                 // 1-5: did the agent give correct info? (diagnostic only)
  "axis_clarity": number,                  // 1-5: was the agent clear/understandable?
  "axis_natural_flow": number,             // 1-5: did it feel like a natural conversation?
  "rationale": string                      // ONE sentence citing the decisive moment
}
success_path is the path the customer agreed to (or "none" for failure/unsure). The axis_* scores are secondary diagnostics — never let them change the verdict.`;

const FEWSHOT_BLOCK =
  FEW_SHOT_ANCHORS.length === 0
    ? ""
    : "\n\nEXAMPLES (held-out gold labels):\n" +
      FEW_SHOT_ANCHORS.map(
        (a) => `TRANSCRIPT:\n${a.transcript}\nVERDICT:\n${JSON.stringify(a.verdict)}`,
      ).join("\n---\n");

/** sha256 of (model id + the full effective system prompt). Bumps judge_version on
 *  ANY prompt or model change so calibration is never silently compared across drift. */
export function judgeVersion(model: string, promptOverride?: string): string {
  const prompt = (promptOverride ?? JUDGE_SYSTEM_PROMPT) + FEWSHOT_BLOCK;
  return crypto.createHash("sha256").update(`${model} ${prompt}`, "utf8").digest("hex").slice(0, 16);
}

/** The static, cacheable system text actually sent (prompt + any few-shots). */
export function judgeSystemText(): string {
  return JUDGE_SYSTEM_PROMPT + FEWSHOT_BLOCK;
}

/** Build the user message for one transcript (already truncated by the caller). */
export function buildUserMessage(transcript: string): string {
  return `Score this call transcript:\n\n${transcript}`;
}

const VERDICTS = new Set<SuccessVerdict>(["success", "failure", "unsure"]);
const PATHS = new Set<SuccessPath>(["sms", "email", "login_activate", "deposit", "none"]);
const axis = (v: unknown): number | null =>
  typeof v === "number" && v >= 1 && v <= 5 ? Math.round(v) : null;

/** Parse the model's reply into a JudgeVerdict, or null if unusable. Tolerant of
 *  prose/```json fences; strict on the success enum (the load-bearing field). */
export function parseVerdict(raw: string): JudgeVerdict | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sv = obj.success_verdict;
  if (typeof sv !== "string" || !VERDICTS.has(sv as SuccessVerdict)) return null;
  const conf =
    typeof obj.success_confidence === "number"
      ? Math.min(1, Math.max(0, obj.success_confidence))
      : 0.5;
  const path =
    typeof obj.success_path === "string" && PATHS.has(obj.success_path as SuccessPath)
      ? (obj.success_path as SuccessPath)
      : "none";
  return {
    success_verdict: sv as SuccessVerdict,
    success_confidence: conf,
    success_path: path,
    axis_accuracy: axis(obj.axis_accuracy),
    axis_clarity: axis(obj.axis_clarity),
    axis_natural_flow: axis(obj.axis_natural_flow),
    rationale: typeof obj.rationale === "string" ? obj.rationale.slice(0, 500) : "",
  };
}
