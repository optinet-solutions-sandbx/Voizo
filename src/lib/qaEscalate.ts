// src/lib/qaEscalate.ts
//
// Two-stage QA scoring. gpt-5.4-mini scores every call cheaply, but it systematically
// mislabels the nuanced Early-Hangup vs Neutral boundary (verified: 4/4 wrong on a call
// the full model gets right 3/3). So when mini returns Early Hang-up or Neutral, we
// double-check that one call with the stronger gpt-5.4 and STORE the stronger verdict —
// the final result is therefore frozen + consistent (VOZ-353), and cost only rises for
// the EH/Neutral subset. All other verdicts (Positive/Declined/Voicemail/Agent-Timeout/
// Unreachable) keep mini's answer untouched. Falls back to mini on any error.
import { supabaseAdmin } from "./supabaseServer";
import { transcriptText } from "./labelData";
import { numberTranscript } from "./qaTranscript";
import { parseCategories } from "./qaBatchData";

const CHECK_MODEL = "gpt-5.4";
const ESCALATE = new Set(["Early Hang-up", "Neutral"]);

/** True when mini's output needs the stronger-model double-check. */
export function needsEscalation(miniContent: string): boolean {
  return ESCALATE.has(parseCategories(miniContent).reachedCategory);
}

/**
 * If mini's result is Early Hang-up / Neutral, re-score the call with gpt-5.4 and return
 * its output; otherwise return mini's output unchanged. Never throws — returns mini's
 * content on any failure (missing transcript, API error, empty response).
 */
export async function verifyCategory(
  callId: string,
  promptContent: string,
  miniContent: string,
  apiKey: string,
): Promise<string> {
  if (!needsEscalation(miniContent)) return miniContent;
  try {
    const { data } = await supabaseAdmin.from("calls_v2").select("transcript").eq("id", callId).maybeSingle();
    const txt = transcriptText(data?.transcript);
    if (!txt.trim()) return miniContent;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CHECK_MODEL,
        messages: [
          { role: "system", content: promptContent },
          { role: "user", content: `Score this call transcript:\n\n${numberTranscript(txt)}` },
        ],
        max_completion_tokens: 4096,
        temperature: 0,
        seed: 7,
      }),
    });
    if (!res.ok) return miniContent;
    const j = await res.json();
    const content = j?.choices?.[0]?.message?.content;
    return content && String(content).trim() ? content : miniContent;
  } catch {
    return miniContent;
  }
}
