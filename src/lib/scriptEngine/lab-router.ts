// Server-only: the organizer's router LLM. Classifies a caller utterance into
// one of the enabled handler intents (or "none").
import OpenAI from "openai";
import type { ListenerHandler } from "./database.types";

export type IntentGuess = { intent: string; confidence: number };

export type Classification = {
  /** Primary (most important) intent — kept for all single-intent logic. */
  intent: string;
  confidence: number;
  /** Every intent the utterance clearly addresses (a reply can contain
   *  several questions/statements), most important first. Max 3. */
  intents: IntentGuess[];
  raw?: string;
};

export async function classifyUtterance(
  utterance: string,
  recentTurns: string[],
  handlers: ListenerHandler[],
  routerModel: string,
  /** Observer's navigation hint: at the current script step, these replies
   *  are the ones the flow is waiting for — listed first and preferred when
   *  the utterance plausibly fits one. */
  expectedKeys: string[] = [],
  /** Fast tier: the handler list contains ONLY the step's expected replies —
   *  a tiny prompt that returns in a fraction of the full pass. The model
   *  may answer "other" to escalate to the full vocabulary. */
  fastTier = false
): Promise<Classification> {
  // Latency cap: a live call measured a 10.5s classification (median ~1.5s) —
  // one provider spike must not stall the turn into idle-nudge territory.
  // Abort at 4s and retry once; a spiked request's retry usually lands fast.
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 4000, maxRetries: 1 });

  // Expected-next handlers lead the list — position in the prompt is weight.
  const expected = new Set(expectedKeys);
  const ordered = expected.size
    ? [...handlers.filter((h) => expected.has(h.intent_key)), ...handlers.filter((h) => !expected.has(h.intent_key))]
    : handlers;
  const handlerLines = ordered
    .map((h) => `- intent_key: ${h.intent_key} — ${h.description || h.name}`)
    .join("\n");
  const expectedLine = expected.size
    ? `\n- The script is at a step where these replies are EXPECTED next: ${expectedKeys.join(", ")}. When the utterance plausibly fits one of them, prefer it over other handlers; if it clearly matches something else, pick what truly matches. A bare agreement ("yes", "yeah", "yup", "okay") right after the agent asked a question maps to the EXPECTED agreement-style handler. If SEVERAL expected handlers fit the same reply (e.g. an agreement matcher plus the scenario that reacts to that agreement), list ALL of them.`
    : "";

  const fastLine = fastTier
    ? `\n- This list is INTENTIONALLY SHORT (only the replies the script expects right now). If the utterance is substantive but clearly addresses something NOT on this list, return intent "other" — do NOT force it into a listed handler and do NOT call it none. none stays reserved for back-channel, fillers and noise.`
    : "";

  const systemPrompt = `You route utterances from a live phone call to handlers. Handlers:
${handlerLines}
- intent_key: none — anything that doesn't clearly need a handler.${fastTier ? `\n- intent_key: other — substantive, but fits nothing in this list.` : ""}

Rules:${expectedLine}${fastLine}
- Back-channel and fillers ("okay", "k", "uh-huh", "right", "hmm", "I hear you", "whatever"), incomplete fragments, a mid-call "hello?", stutters, or background noise → none. These are acknowledgements, not requests.
- Bare agreement ("yes", "sure", "okay") matches a consent/offer handler ONLY if the agent's last line in the recent turns asked exactly that question; otherwise → none.
- Hedged or reluctant agreement still counts as agreement: "yeah I guess", "okay fine", "sure, whatever", a bare "okay" — if the agent's last line asked a yes/no question, map these to that question's handler (confidence around 0.8). Only a clear refusal or a new topic breaks the match.
- Pick a handler only for a substantive reply or question that clearly needs that handler's knowledge or action. When unsure, pick none with low confidence.
- A reply that is substantive but fits NOTHING in the conversation — a random word or phrase, a non-sequitur right after a question (often a speech-to-text mishearing, like "store" when they meant "sure") → the unclear/misheard-reply handler if one is listed. Do not force it into another handler, and do not call it none (none is only for back-channel, fillers, and noise).
- A voicemail greeting, recorded message, carrier intercept, or automated phone menu — NOT a live person ("leave a message", "after the tone", "you've reached", "press 1", "number not in service") → the voicemail/machine handler with HIGH confidence. Recordings never produce a sale.
- A reply can contain SEVERAL statements or questions ("yes please — and how much is it?"). List every handler it clearly addresses, most important first — usually one, at most three.
- An agreement or refusal WITH a question attached ("yes — who is this again?", "sure, but how much?") addresses TWO handlers: the question's handler AND the agreement/refusal handler. NEVER drop the agreement/refusal part — even when the question feels more important, the agreement decides where the call goes next. List the question first, the agreement/refusal second.

Given the last customer utterance (and brief context), return ONLY JSON:
{"intents":[{"intent":"<intent_key or none>","confidence":<0..1>}]}`;

  const contextBlock =
    recentTurns.length > 0 ? `Recent turns:\n${recentTurns.join("\n")}\n\n` : "";

  // gpt-5.x models reject custom temperature and prefer max_completion_tokens;
  // build params loosely so the model is swappable from lab settings.
  const params: Record<string, unknown> = {
    model: routerModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${contextBlock}Customer utterance: "${utterance}"` },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 600,
  };
  // gpt-5.x models reject custom temperature; older models prefer max_tokens.
  if (!routerModel.startsWith("gpt-5")) {
    params.temperature = 0;
    params.max_tokens = 100;
    delete params.max_completion_tokens;
  }

  let completion;
  try {
    completion = await openai.chat.completions.create(
      params as unknown as Parameters<typeof openai.chat.completions.create>[0]
    );
  } catch (e: unknown) {
    // Retry once without response_format for models that don't support json_object
    if (e instanceof Error && /response_format|json_object/i.test(e.message)) {
      delete params.response_format;
      completion = await openai.chat.completions.create(
        params as unknown as Parameters<typeof openai.chat.completions.create>[0]
      );
    } else {
      throw e;
    }
  }

  const raw =
    "choices" in completion ? completion.choices[0]?.message?.content ?? "" : "";
  const none: Classification = { intent: "none", confidence: 0, intents: [{ intent: "none", confidence: 0 }], raw };
  try {
    // Tolerate markdown fences / prose around the JSON
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
    const parsed = JSON.parse(jsonText);
    const clamp = (n: unknown) => (typeof n === "number" ? Math.max(0, Math.min(1, n)) : 0);
    // New shape {intents:[...]} with legacy {intent,confidence} still accepted.
    let intents: IntentGuess[] = Array.isArray(parsed.intents)
      ? parsed.intents
          .filter((g: unknown): g is Record<string, unknown> => !!g && typeof g === "object")
          .filter((g: Record<string, unknown>) => typeof g.intent === "string")
          .map((g: Record<string, unknown>) => ({ intent: g.intent as string, confidence: clamp(g.confidence) }))
      : typeof parsed.intent === "string"
        ? [{ intent: parsed.intent, confidence: clamp(parsed.confidence) }]
        : [];
    intents = intents.slice(0, 3);
    if (intents.length === 0) return none;
    return { intent: intents[0].intent, confidence: intents[0].confidence, intents, raw };
  } catch {
    return none;
  }
}
