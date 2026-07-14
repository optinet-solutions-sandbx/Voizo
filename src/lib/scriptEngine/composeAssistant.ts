// Clone-time prompt/config composition for SCRIPT campaigns (VOZ-156).
//
// Ported from the source app's app/api/lab/configure-assistant/route.ts, but
// keyed on a specific script_id (per-campaign) instead of the global
// lab_settings.active_script_id. It produces the pieces a script clone needs;
// createClone applies them behind its `scriptClone` override (agent-mode is
// untouched). The result is deterministic for a given graph, so
// snapshotCampaignPrompt versions the composed prompt for free.
//
// The composed system prompt = wait-phrase ban + persona + universal operating
// rules + script rules 8-9 + optional [Opening] + [STANDING ANSWERS] + the
// entry [CURRENT STAGE]. The webhook pushes each *next* stage as the flow
// advances; only the entry stage ships in the prompt.
import { getScriptGraph, listHandlers } from "./lab-db";
import { findEntryNode } from "./lab-flow";
import { compileStageBriefing, compileStandingAnswers } from "./lab-briefing";
import { LAB_OPERATING_RULES, DEFAULT_SHORT_PROMPT } from "./lab-tools";

export interface ScriptCloneConfig {
  /** Fully composed system message. Applied WITHOUT the VOIZO_SYSTEM_PREFIX
   *  (the engine's own rules supersede it — plan §2.3). */
  composedPrompt: string;
  /** Start-box opening. null => let Vapi use its default greeting. */
  firstMessage: string | null;
  firstMessageMode: string | null;
  serverMessages: string[];
  stopSpeakingPlan: Record<string, unknown>;
  startSpeakingPlan: Record<string, unknown>;
  messagePlan: Record<string, unknown>;
  monitorPlan: Record<string, unknown>;
  /** Deepgram keyterms to merge into the base transcriber (STT accuracy). */
  transcriberKeyterms: string[];
  /** Script mode gives the model NO tools — every remaining "hold on" in live
   *  calls was the model announcing a tool call. The engine drives everything. */
  noTools: boolean;
}

// The wait-phrase ban is bookended (also inside LAB_OPERATING_RULES) — it kept
// leaking from an end-only position.
const WAIT_PHRASE_BAN =
  `ABSOLUTE RULE — never say "hold on", "hold on a sec", "one moment", "just a sec", "just a moment", "give me a second", "please hold" or any wait-phrase, in any situation, ever. If you need a beat: one tiny casual filler ("mm-hmm", "okay so—") or silence.`;

// Script mode (brief-ahead): the graph is compiled into [CURRENT STAGE]
// sections the model answers from natively — no waiting for injected lines.
const SCRIPT_RULES =
  `\n8. This call follows a script delivered as [CURRENT STAGE] sections — the NEWEST one alone governs your replies; older ones are void. Every customer turn gets an IMMEDIATE reply chosen from the current stage: pick the path that fits, blend the matching lines into ONE short reply if the customer raised several points, keep facts, prices and terms word-accurate, and say word-for-word lines exactly as written. If nothing in the stage fits, use a fitting [STANDING ANSWERS] entry (briefly, then return to the stage) or the stage's fallback path. Never invent facts, offers, account activity or questions the script didn't supply. NEVER re-answer ground you already covered: "hello?" or "are you there?" gets a ONE-SENTENCE recap of your last point, never the full line again; an interruption means you resume with only what you had not yet said — never restart. Never wait in silence for instructions: the stage in hand IS your instruction.
9. APPROVED FILLERS — the ONLY words you may add around the scripted lines: "mm-hmm", "uh-huh", "right—", "okay so—", "got it.", "perfect.", "fair question—", "alright—", "sounds good—". At most one per reply; never the same one twice in a call. Pace: calm and unhurried, short sentences, a natural beat between your reply and any extra statements — a longer reply is never a reason to speak faster.`;

// STT accuracy: bias the transcriber toward campaign vocabulary. createClone
// merges these into the base assistant's existing keyterms (Deepgram only).
const BASE_KEYTERMS = [
  "SMS", "text message", "free spins", "spins", "deposit", "bonus",
  "promotion", "promo", "claim", "account", "casino", "log in", "website",
  "Lucky Seven",
];

// Interruptions are analyzed, not knee-jerk (numWords 3); channel checks +
// acknowledgements never stop the agent; explicit interruption words cut in.
const STOP_SPEAKING_PLAN = {
  numWords: 3,
  backoffSeconds: 1,
  acknowledgementPhrases: [
    "okay", "ok", "yeah", "yes", "uh-huh", "mm-hmm", "mhm", "right",
    "sure", "got it", "i see", "alright", "gotcha", "cool", "i hear you",
    "hello", "hello hello", "are you there", "you there", "can you hear me",
  ],
  interruptionPhrases: ["stop", "wait", "hold on", "no no", "excuse me", "actually", "question"],
};

// Smart endpointing coalesces split finals; keep the wait short so fillers can
// start the instant the customer stops.
const START_SPEAKING_PLAN = { waitSeconds: 0.5, smartEndpointingPlan: { provider: "vapi" } };

// Dead-air plan: the listener loop is transcript-driven, so customer silence
// otherwise means nothing happens. The watchdog's noise filter knows these
// exact strings — do not reword without updating lab-watchdog.
const MESSAGE_PLAN = {
  idleMessages: [
    "Take your time — I'm still here.",
    "Are you still with me?",
    "Can you hear me okay?",
  ],
  idleTimeoutSeconds: 12,
  idleMessageMaxSpokenCount: 2,
};

const MONITOR_PLAN = { listenEnabled: true, controlEnabled: true };

// transcript partials included — the engine's anticipation needs them (plan §6.3
// on webhook volume). speech-update powers the speaking lock + started-speaking.
const SERVER_MESSAGES = ["tool-calls", "transcript", "status-update", "speech-update", "end-of-call-report"];

const renderName = (s: string) => s.replace(/\{\{\s*name\s*\}\}/gi, "there").replace(/\s{2,}/g, " ");

/**
 * Compose the clone-time config for a script campaign.
 * @param scriptId  the campaign's listener_scripts id
 * @param persona   the campaign's system_prompt (who the agent is). Falls back
 *                  to the engine default when blank.
 */
export async function composeScriptClone(opts: { scriptId: string; persona?: string | null }): Promise<ScriptCloneConfig> {
  const { scriptId } = opts;
  const graph = await getScriptGraph(scriptId);
  const handlers = await listHandlers().catch(() => []);

  const startN = graph.nodes.find((n) => n.type === "start");
  const sc = (startN?.config ?? {}) as Record<string, unknown>;
  const opening = ((sc.opening as string) ?? "").trim();
  const openingReword = ((sc.openingDelivery as string) ?? "verbatim") === "reword";

  // Reworded opening: the model generates the first message itself, so the gist
  // must live in the prompt as an [Opening] rule.
  let openingRule = "";
  if (opening && openingReword) {
    openingRule = `\n\n[Opening] Open the call in your own words with exactly this meaning — one short greeting and the question, nothing more: "${renderName(opening)}"`;
  }

  // The entry stage + standing-answers bank ship in the prompt so the model can
  // answer the very first reply before any webhook turn has run.
  const entry = findEntryNode(graph.nodes, graph.edges);
  const standing = await compileStandingAnswers(graph, handlers).catch(() => null);
  const entryStage = entry ? await compileStageBriefing(graph, entry.id, handlers).catch(() => null) : null;

  const personaText = (opts.persona ?? "").trim() || DEFAULT_SHORT_PROMPT;
  const composedPrompt =
    `${WAIT_PHRASE_BAN}\n\n${personaText}\n\n${LAB_OPERATING_RULES}${SCRIPT_RULES}${openingRule}` +
    `${standing ? `\n\n${standing}` : ""}${entryStage ? `\n\n${entryStage}` : ""}`;

  // firstMessage from the Start box: exact opening → literal firstMessage;
  // reworded → model generates (the [Opening] rule steers it); empty → default.
  let firstMessage: string | null = null;
  let firstMessageMode: string | null = null;
  if (opening && !openingReword) {
    firstMessage = renderName(opening);
    firstMessageMode = "assistant-speaks-first";
  } else if (opening && openingReword) {
    firstMessageMode = "assistant-speaks-first-with-model-generated-message";
  }

  return {
    composedPrompt,
    firstMessage,
    firstMessageMode,
    serverMessages: SERVER_MESSAGES,
    stopSpeakingPlan: STOP_SPEAKING_PLAN,
    startSpeakingPlan: START_SPEAKING_PLAN,
    messagePlan: MESSAGE_PLAN,
    monitorPlan: MONITOR_PLAN,
    transcriberKeyterms: BASE_KEYTERMS,
    noTools: true,
  };
}
