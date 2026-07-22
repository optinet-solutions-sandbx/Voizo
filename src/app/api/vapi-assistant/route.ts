/**
 * /api/vapi-assistant — read + patch a single Vapi assistant (VOZ-186).
 *
 * Ported from the source app (vapi-voiceagent-test) for the Script Builder's
 * lab config panel: GET pre-fills the panel, PATCH pushes prompt/voice/settings
 * when the operator hits Save Configuration. The panel was ported to Voizo
 * without this route — Save silently failed. One adaptation: the source app's
 * hardcoded fallback assistant is replaced by VAPI_SCRIPT_BASE_ASSISTANT_ID
 * (the ONE shared test/clone-donor agent — team decision 2026-07-22).
 *
 * Server-side only — the Vapi private key never leaves this handler.
 */

import { NextResponse } from "next/server";

const VAPI_BASE = "https://api.vapi.ai";

function resolveEnv(bodyId?: string | null): { assistantId?: string; key?: string; err?: NextResponse } {
  const key = process.env.VAPI_PRIVATE_KEY;
  const assistantId = bodyId || process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;
  if (!key) {
    return { err: NextResponse.json({ error: "VAPI_PRIVATE_KEY is not set" }, { status: 500 }) };
  }
  if (!assistantId) {
    return {
      err: NextResponse.json(
        { error: "assistantId missing and VAPI_SCRIPT_BASE_ASSISTANT_ID is not set" },
        { status: 500 },
      ),
    };
  }
  // Pin to the ONE designated agent (adversarial review 2026-07-22, finding 2):
  // without this, any Basic-Auth holder could PATCH a LIVE campaign clone's
  // prompt/voice through the lab. The dropdown offers one agent; the API
  // enforces the same policy.
  const designated = process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;
  if (designated && assistantId !== designated) {
    return {
      err: NextResponse.json(
        { error: "The lab only operates on the designated script-base assistant" },
        { status: 403 },
      ),
    };
  }
  return { assistantId, key };
}

// GET /api/vapi-assistant?assistantId=xxx
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const { assistantId, key, err } = resolveEnv(searchParams.get("assistantId"));
  if (err) return err;

  const res = await fetch(`${VAPI_BASE}/assistant/${assistantId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: text }, { status: res.status });
  }

  const assistant = await res.json();

  let systemPrompt: string | null = null;
  const messages: Array<{ role: string; content: string }> = assistant?.model?.messages ?? [];
  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg) systemPrompt = systemMsg.content;
  else if (assistant?.model?.systemPrompt) systemPrompt = assistant.model.systemPrompt;

  // Surface the editable subset to the client.
  const settings = {
    name: assistant?.name ?? null,
    firstMessage: assistant?.firstMessage ?? null,
    firstMessageMode: assistant?.firstMessageMode ?? null,
    voicemailMessage: assistant?.voicemailMessage ?? null,
    endCallMessage: assistant?.endCallMessage ?? null,
    endCallPhrases: assistant?.endCallPhrases ?? null,
    maxDurationSeconds: assistant?.maxDurationSeconds ?? null,
    silenceTimeoutSeconds: assistant?.silenceTimeoutSeconds ?? null,
    responseDelaySeconds: assistant?.responseDelaySeconds ?? null,
    backgroundSound: assistant?.backgroundSound ?? null,
    server: assistant?.server ?? null,
    artifactPlan: assistant?.artifactPlan ?? null,
    voicemailDetection: assistant?.voicemailDetection ?? null,
    analysisPlan: assistant?.analysisPlan ?? null,
    model: assistant?.model
      ? {
          provider: assistant.model.provider ?? null,
          model: assistant.model.model ?? null,
          temperature: assistant.model.temperature ?? null,
        }
      : null,
    transcriber: assistant?.transcriber ?? null,
  };

  return NextResponse.json({ systemPrompt, assistant, settings });
}

// Allowlisted top-level assistant fields the client may PATCH.
const ALLOWED_FIELDS = new Set([
  "name",
  "firstMessage",
  "firstMessageMode",
  "voicemailMessage",
  "endCallMessage",
  "endCallPhrases",
  "maxDurationSeconds",
  "silenceTimeoutSeconds",
  "responseDelaySeconds",
  "backgroundSound",
  "server",
  "serverMessages",
  "monitorPlan",
  "artifactPlan",
  "voicemailDetection",
  "analysisPlan",
  "transcriber",
]);

// PATCH /api/vapi-assistant — body supports:
//   { assistantId?, systemPrompt?, voice?, modelConfig?: { provider?, model?, temperature? }, settings?: Record<string, unknown> }
export async function PATCH(req: Request) {
  const body = await req.json();
  const {
    assistantId: bodyId,
    systemPrompt,
    voice,
    modelConfig,
    settings,
  } = body as {
    assistantId?: string;
    systemPrompt?: string;
    voice?: { provider: string; voiceId: string };
    modelConfig?: { provider?: string; model?: string; temperature?: number };
    settings?: Record<string, unknown>;
  };

  const { assistantId, key, err } = resolveEnv(bodyId);
  if (err) return err;

  const wantsSystemPrompt = systemPrompt !== undefined;
  const wantsVoice = voice !== undefined;
  const wantsModelConfig = modelConfig !== undefined && Object.keys(modelConfig).length > 0;
  const wantsSettings = settings !== undefined && Object.keys(settings).length > 0;

  if (!wantsSystemPrompt && !wantsVoice && !wantsModelConfig && !wantsSettings) {
    return NextResponse.json(
      { error: "Provide at least one of: systemPrompt, voice, modelConfig, settings" },
      { status: 400 }
    );
  }

  // We have to read the current assistant to preserve fields we don't touch
  // (notably model.messages when patching model.provider/model/temperature, since
  // VAPI's model object is replaced wholesale on PATCH).
  const getRes = await fetch(`${VAPI_BASE}/assistant/${assistantId}`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!getRes.ok) {
    const text = await getRes.text();
    return NextResponse.json({ error: text }, { status: getRes.status });
  }

  const assistant = await getRes.json();
  const patchBody: Record<string, unknown> = {};

  if (wantsSystemPrompt && typeof systemPrompt === "string") {
    const model = assistant?.model ?? {};
    const existingMessages: Array<{ role: string; content: string }> = model.messages ?? [];
    const hasSystem = existingMessages.some((m) => m.role === "system");
    const newMessages = hasSystem
      ? existingMessages.map((m) =>
          m.role === "system" ? { ...m, content: systemPrompt } : m
        )
      : [{ role: "system", content: systemPrompt }, ...existingMessages];
    patchBody.model = { ...model, messages: newMessages };
  }

  if (wantsVoice && voice) {
    // MERGE over the existing voice — wholesale replacement drops the tuned
    // knobs (stability, similarityBoost, SSML, model) and campaign clones
    // inherit base.voice verbatim. That exact incident is documented in
    // cloneAssistant.ts (2026-05-07 clone-drift investigation).
    patchBody.voice = { ...(assistant?.voice ?? {}), ...voice };
  }

  if (wantsModelConfig && modelConfig) {
    const existingModel = (patchBody.model as Record<string, unknown>) ?? assistant?.model ?? {};
    patchBody.model = {
      ...existingModel,
      ...(modelConfig.provider ? { provider: modelConfig.provider } : {}),
      ...(modelConfig.model ? { model: modelConfig.model } : {}),
      ...(typeof modelConfig.temperature === "number"
        ? { temperature: modelConfig.temperature }
        : {}),
    };
  }

  if (wantsSettings && settings) {
    for (const [k, v] of Object.entries(settings)) {
      if (ALLOWED_FIELDS.has(k)) {
        patchBody[k] = v;
      }
    }
  }

  const patchRes = await fetch(`${VAPI_BASE}/assistant/${assistantId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patchBody),
  });

  if (!patchRes.ok) {
    const text = await patchRes.text();
    return NextResponse.json({ error: text }, { status: patchRes.status });
  }

  return NextResponse.json({ ok: true });
}
