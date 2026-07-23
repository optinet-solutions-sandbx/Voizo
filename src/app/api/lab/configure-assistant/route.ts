// One-click "Configure for Lab": attaches tools, serverMessages, server.url and
// monitorPlan to the chosen assistant so the listener loop can run.
//
// Ported from the source app (vapi-voiceagent-test) for VOZ-186 — the Script
// Builder's Save Configuration + pre-dial push called this route, but the port
// left it behind. Voizo adaptations:
//   1. Helper imports point at src/lib/scriptEngine/* (the ported engine).
//   2. Webhook base URL resolution ladder: operator override (ngrok dev) →
//      LAB_WEBHOOK_BASE_URL → origin of VAPI_WEBHOOK_URL → the same literal
//      fallback the clone route uses. No new env var required in prod.
//   3. server.secret = VAPI_WEBHOOK_SECRET, so /api/lab/webhook can verify
//      x-vapi-secret (it is exempted from Basic Auth in middleware — the
//      secret IS its auth, same as the campaign webhooks).
import { NextResponse } from "next/server";
// Relative imports — vitest does not resolve "@/" (testable-route convention).
import { LAB_TOOLS, LAB_OPERATING_RULES, DEFAULT_SHORT_PROMPT } from "../../../../lib/scriptEngine/lab-tools";
import { getLabSettings, saveLabSettings, listHandlers, getScriptGraph, getScript } from "../../../../lib/scriptEngine/lab-db";
import { compileStageBriefing, compileStandingAnswers } from "../../../../lib/scriptEngine/lab-briefing";
import { findEntryNode } from "../../../../lib/scriptEngine/lab-flow";

const VAPI_BASE = "https://api.vapi.ai";

/** Origin of VAPI_WEBHOOK_URL (the campaign webhook env) — same host serves the lab. */
function vapiWebhookOrigin(): string {
  const u = process.env.VAPI_WEBHOOK_URL;
  if (!u) return "";
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  const apiKey = process.env.VAPI_PRIVATE_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "VAPI_PRIVATE_KEY not configured" }, { status: 500 });
  }

  const { assistantId } = (await req.json()) as { assistantId?: string };
  if (!assistantId) {
    return NextResponse.json({ error: "assistantId required" }, { status: 400 });
  }
  // Pin to the ONE designated agent (adversarial review 2026-07-22, finding 2):
  // configuring any other assistant would repoint a LIVE campaign clone's
  // webhook at the lab and replace its tools — end-of-call/SMS would die
  // silently for that campaign.
  const designated = process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;
  if (designated && assistantId !== designated) {
    return NextResponse.json(
      { error: "The lab only operates on the designated script-base assistant" },
      { status: 403 },
    );
  }

  const settings = await getLabSettings().catch(() => null);
  const base =
    settings?.server_url_override?.trim() ||
    process.env.LAB_WEBHOOK_BASE_URL ||
    vapiWebhookOrigin() ||
    "https://voizo-eight.vercel.app";
  // Users tend to paste full page URLs (e.g. .../listener-lab) — keep only the origin.
  let origin: string;
  try {
    origin = new URL(base.includes("://") ? base : `https://${base}`).origin;
  } catch {
    return NextResponse.json({ error: `Invalid webhook base URL: ${base}` }, { status: 400 });
  }
  const webhookUrl = `${origin}/api/lab/webhook`;

  // GET current assistant to preserve model.messages etc.
  const getRes = await fetch(`${VAPI_BASE}/assistant/${assistantId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!getRes.ok) {
    const text = await getRes.text();
    return NextResponse.json({ error: text }, { status: getRes.status });
  }
  const assistant = await getRes.json();

  // The system prompt is COMPOSED, not written: the campaign persona comes
  // from the Playbook's special "identity" scenario (editable next to the
  // opening line, swapped per campaign like any other data), falling back to
  // lab_settings.short_prompt; the universal listener operating rules are
  // appended so campaigns never duplicate mechanics. Identity must be
  // standing prompt material — on un-injected turns an agent with no identity
  // invents one (the "BrightPath" incident).
  const identityScenario = await listHandlers()
    .then((hs) => hs.find((h) => h.intent_key === "identity" && h.enabled))
    .catch(() => undefined);
  // VOZ-188: the ACTIVE script's own persona (edited in the builder drawer)
  // outranks the global identity — so a ▶ test call speaks exactly what the
  // wizard will launch for this script. Blank persona = legacy ladder.
  const activeScript = settings?.active_script_id
    ? await getScript(settings.active_script_id).catch(() => null)
    : null;
  const persona =
    (activeScript?.persona ?? "").trim() ||
    identityScenario?.response_template?.trim() ||
    settings?.short_prompt?.trim() ||
    DEFAULT_SHORT_PROMPT;
  // The wait-phrase ban is bookended: first line of the prompt AND inside the
  // hard rules — it kept leaking from an end-only position.
  // Script mode (brief-ahead): the graph is compiled into [CURRENT STAGE]
  // sections the model answers from NATIVELY — no waiting for injected
  // lines. The entry stage ships inside this prompt; the webhook pushes each
  // next stage as the flow advances.
  const scriptRule = settings?.active_script_id
    ? `\n8. This call follows a script delivered as [CURRENT STAGE] sections — the NEWEST one alone governs your replies; older ones are void. Every customer turn gets an IMMEDIATE reply chosen from the current stage: pick the path that fits, blend the matching lines into ONE short reply if the customer raised several points, keep facts, prices and terms word-accurate, and say word-for-word lines exactly as written. If nothing in the stage fits, use a fitting [STANDING ANSWERS] entry (briefly, then return to the stage) or the stage's fallback path. Never invent facts, offers, account activity or questions the script didn't supply. NEVER re-answer ground you already covered: "hello?" or "are you there?" gets a ONE-SENTENCE recap of your last point, never the full line again; an interruption means you resume with only what you had not yet said — never restart. Never wait in silence for instructions: the stage in hand IS your instruction.
9. APPROVED FILLERS — the ONLY words you may add around the scripted lines: "mm-hmm", "uh-huh", "right—", "okay so—", "got it.", "perfect.", "fair question—", "alright—", "sounds good—". At most one per reply; never the same one twice in a call. Pace: calm and unhurried, short sentences, a natural beat between your reply and any extra statements — a longer reply is never a reason to speak faster.`
    : "";
  // Reworded opening: the model generates the first message itself (the run
  // sets firstMessageMode accordingly), so the gist must live in the prompt.
  // The ENTRY stage briefing also ships in the prompt — the model must know
  // how to answer the very first reply before any webhook turn has run.
  let openingRule = "";
  let entryStage = "";
  let standing = "";
  if (settings?.active_script_id) {
    try {
      const g = await getScriptGraph(settings.active_script_id);
      const startN = g.nodes.find((n) => n.type === "start");
      const sc = (startN?.config ?? {}) as Record<string, unknown>;
      const op = ((sc.opening as string) ?? "").trim();
      if (op && (sc.openingDelivery as string) === "reword")
        openingRule = `\n\n[Opening] Open the call in your own words with exactly this meaning — one short greeting and the question, nothing more: "${op.replace(/\{\{\s*name\s*\}\}/gi, "there")}"`;
      const entry = findEntryNode(g.nodes, g.edges);
      const handlers = await listHandlers().catch(() => []);
      // The answer bank behind every stage: what the retired reactive layer
      // used to do for off-script questions, now in the model's own hands.
      const sa = await compileStandingAnswers(g, handlers).catch(() => null);
      if (sa) standing = `\n\n${sa}`;
      if (entry) {
        const briefing = await compileStageBriefing(g, entry.id, handlers).catch(() => null);
        if (briefing) entryStage = `\n\n${briefing}`;
      }
    } catch {
      /* no graph → no opening rule / entry stage */
    }
  }

  const prompt = `ABSOLUTE RULE — never say "hold on", "hold on a sec", "one moment", "just a sec", "just a moment", "give me a second", "please hold" or any wait-phrase, in any situation, ever. If you need a beat: one tiny casual filler ("mm-hmm", "okay so—") or silence.\n\n${persona}\n\n${LAB_OPERATING_RULES}${scriptRule}${openingRule}${standing}${entryStage}`;

  const model = assistant.model ?? {};
  let messages: Array<{ role: string; content: string }> = model.messages ?? [];
  const hasSystem = messages.some((m) => m.role === "system");
  messages = hasSystem
    ? messages.map((m) => (m.role === "system" ? { ...m, content: prompt } : m))
    : [{ role: "system", content: prompt }, ...messages];

  // In script mode the agent gets NO tools: all four are gated to stand down
  // anyway, and every remaining "just a sec"/"hold on" in live calls was the
  // model announcing its own tool calls. No tools → no announcements, and no
  // wasted roundtrips. Without a script, the classic tool loop still works.
  const tools = settings?.active_script_id ? [] : LAB_TOOLS;

  // STT accuracy: bias the transcriber toward campaign vocabulary so
  // ambiguous audio resolves to domain words ("sure" not "store", "spins"
  // not "since"). Custom keyterms already on the assistant are preserved.
  const BASE_KEYTERMS = [
    "SMS", "text message", "free spins", "spins", "deposit", "bonus",
    "promotion", "promo", "claim", "account", "casino", "log in", "website",
    "Lucky Seven",
  ];
  const tr = (assistant.transcriber ?? {}) as Record<string, unknown>;
  const transcriber =
    ((tr.provider as string) ?? "deepgram") === "deepgram"
      ? {
          ...tr,
          provider: (tr.provider as string) ?? "deepgram",
          model: (tr.model as string) ?? "flux-general-en",
          language: (tr.language as string) ?? "en",
          keyterm: [...new Set([...(Array.isArray(tr.keyterm) ? (tr.keyterm as string[]) : []), ...BASE_KEYTERMS])],
        }
      : undefined;

  const patchBody = {
    model: { ...model, messages, tools },
    ...(transcriber ? { transcriber } : {}),
    server: {
      url: webhookUrl,
      timeoutSeconds: 20,
      // /api/lab/webhook verifies this — without it Vapi's events are rejected.
      // Same fallback chain as the gate itself (VAPI_WEBHOOK_SECRET ||
      // VAPI_PRIVATE_KEY): the gate fires whenever EITHER is set, so the
      // provisioned secret must match whichever the gate will use.
      secret: process.env.VAPI_WEBHOOK_SECRET || apiKey,
    },
    serverMessages: [
      "tool-calls",
      "transcript",
      "status-update",
      // Real-time speaking state: powers the speaking lock (never inject over
      // the agent mid-sentence) and started-speaking detection. Without this
      // in serverMessages, Vapi never sends the events and both are blind.
      "speech-update",
      "end-of-call-report",
    ],
    monitorPlan: { listenEnabled: true, controlEnabled: true },
    // Dead-air plan: the whole listener loop is transcript-driven, so customer
    // silence otherwise means nothing ever happens. These re-engage naturally,
    // at most twice, without sounding like a stuck record.
    messagePlan: {
      // Content-neutral nudges only — "want me to go over that again?"
      // presumed content and sounded absurd right after the opener.
      idleMessages: [
        "Take your time — I'm still here.",
        "Are you still with me?",
        "Can you hear me okay?",
      ],
      idleTimeoutSeconds: 12,
      idleMessageMaxSpokenCount: 2,
    },
    // Interruptions are analyzed, not knee-jerk: acknowledgements and noise
    // never stop the agent; three or more words do; explicit interruption
    // words ("stop", "wait") cut through instantly.
    stopSpeakingPlan: {
      numWords: 3,
      backoffSeconds: 1,
      acknowledgementPhrases: [
        "okay", "ok", "yeah", "yes", "uh-huh", "mm-hmm", "mhm", "right",
        "sure", "got it", "i see", "alright", "gotcha", "cool", "i hear you",
        // Channel checks aren't replies either — keep talking through them;
        // the listener holds navigation on them too (backchannel gate).
        "hello", "hello hello", "are you there", "you there", "can you hear me",
      ],
      interruptionPhrases: ["stop", "wait", "hold on", "no no", "excuse me", "actually", "question"],
    },
    // Wait for the customer to actually finish before replying (smart
    // endpointing coalesces split finals) — but keep the wait short: fillers
    // only buy time if they start the instant the customer stops, and the
    // supersede/lock guards already handle fragment stragglers.
    startSpeakingPlan: { waitSeconds: 0.5, smartEndpointingPlan: { provider: "vapi" } },
  };

  const patchRes = await fetch(`${VAPI_BASE}/assistant/${assistantId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(patchBody),
  });
  if (!patchRes.ok) {
    const text = await patchRes.text();
    return NextResponse.json({ error: text }, { status: patchRes.status });
  }

  await saveLabSettings({ lab_assistant_id: assistantId }).catch(() => {});

  return NextResponse.json({
    ok: true,
    assistantId,
    assistantName: assistant.name ?? null,
    webhookUrl,
    toolCount: tools.length,
  });
}

// GET returns the resolved default base URL so the UI can display it.
export async function GET() {
  return NextResponse.json({
    envBaseUrl:
      process.env.LAB_WEBHOOK_BASE_URL || vapiWebhookOrigin() || "https://voizo-eight.vercel.app",
  });
}
