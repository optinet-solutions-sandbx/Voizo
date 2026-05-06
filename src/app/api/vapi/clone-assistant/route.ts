/**
 * POST /api/vapi/clone-assistant
 *
 * Clone-per-campaign: creates a new Vapi assistant by copying the base
 * assistant's config and applying voice + prompt overrides. Each campaign
 * gets its own isolated assistant — no shared state, no race conditions.
 *
 * Server-side only — VAPI_PRIVATE_KEY never leaves this handler.
 *
 * Request body:
 *   { baseAssistantId, voiceId?, systemPrompt?, campaignName }
 *
 * Returns:
 *   { assistantId, assistantName, sipUri }
 */

import { NextRequest, NextResponse } from "next/server";

const KNOWN_VOICES: Record<string, string> = {
  "3jR9BuQAOPMWUjWpi0ll": "Stephen",
  "UgBBYS2sOqTuMpoF3BR0": "Mark",
  "6YQMyaUWlj0VX652cY1C": "Mark (Natural)",
  "2zGvynULFssveGrcP8hi": "Jackson",
  "YaarrMwvJxVUpjbZ2RpC": "George",
  "pHqSZYhjNK8nDCPRglTL": "Alex",
  "1IthILLNX448pH19aMvC": "Matthew",
  "pNInz6obpgDQGcFmaJgB": "Adam",
};

export async function POST(request: NextRequest) {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "VAPI_PRIVATE_KEY is not set" },
      { status: 500 },
    );
  }

  const sipAuthPassword = process.env.VAPI_SIP_AUTH_PASSWORD;
  if (!sipAuthPassword) {
    return NextResponse.json(
      { error: "VAPI_SIP_AUTH_PASSWORD is not set" },
      { status: 500 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const baseAssistantId = body.baseAssistantId as string | undefined;
  const voiceId = body.voiceId as string | undefined;
  const systemPrompt = body.systemPrompt as string | undefined;
  const campaignName = body.campaignName as string | undefined;

  if (!baseAssistantId || typeof baseAssistantId !== "string" || baseAssistantId.length > 100) {
    return NextResponse.json({ error: "baseAssistantId is required" }, { status: 400 });
  }

  if (voiceId && !KNOWN_VOICES[voiceId]) {
    return NextResponse.json({ error: "Unknown voiceId" }, { status: 400 });
  }

  if (systemPrompt && systemPrompt.length > 20_000) {
    return NextResponse.json({ error: "systemPrompt too long (max 20,000 chars)" }, { status: 400 });
  }

  // ── 1. Fetch base assistant from Vapi ──
  const baseRes = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(baseAssistantId)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    cache: "no-store",
  });

  if (!baseRes.ok) {
    const errText = await baseRes.text();
    return NextResponse.json(
      { error: `Failed to fetch base assistant: ${errText.slice(0, 200)}` },
      { status: baseRes.status === 404 ? 400 : 502 },
    );
  }

  const base = await baseRes.json();

  // ── 2. Build clone payload ──
  const voiceName = voiceId ? KNOWN_VOICES[voiceId] : null;
  const voiceSuffix = voiceName ? ` (${voiceName})` : "";
  const baseName = campaignName
    ? campaignName
    : `Clone – ${(base.name ?? "Unnamed").slice(0, 20)}`;
  const withVoice = baseName + voiceSuffix;
  const cloneName = withVoice.length <= 60 ? withVoice : baseName.slice(0, 60);

  const cloneVoice = voiceId
    ? { provider: "11labs", voiceId, model: "eleven_turbo_v2_5", stability: 0.85, similarityBoost: 0.75, optimizeStreamingLatency: 3, enableSsmlParsing: false }
    : base.voice;

  // ── Voizo system prefix (Chris's architecture: system prompt + agent prompt = 1 prompt) ──
  // Dev-controlled instructions that every cloned assistant receives, prepended
  // to whatever agent prompt Ernie/Maria configure. Ensures predictable AI
  // behavior for post-call evaluation (SMS confirmation phrasing, call ending).
  // Vapi only allows one system message, so we concatenate.
  const VOIZO_SYSTEM_PREFIX = [
    `[System Instructions — Voizo Platform]`,
    `Important call behavior rules that apply to every call:`,
    ``,
    `1. SMS CONFIRMATION: When the customer agrees to receive SMS or text details,`,
    `   you MUST verbally confirm by saying something like "I'll send you an SMS now"`,
    `   before moving on. Do not skip this step — it is required for SMS delivery to work.`,
    ``,
    `2. CALL ENDING: Never end the call immediately after the customer agrees to receive`,
    `   SMS. Confirm the SMS dispatch first, then wrap up the call politely.`,
    ``,
    `3. OPT-OUT: If the customer explicitly asks not to be called again, acknowledge`,
    `   their request respectfully before ending the call.`,
    ``,
    `[End System Instructions]`,
    ``,
    ``,
  ].join("\n");

  const cloneMessages = base.model?.messages ? [...base.model.messages] : [];

  // Determine agent prompt: custom override from request, or base assistant's existing prompt
  const sysIdx = cloneMessages.findIndex((m: { role: string }) => m.role === "system");
  const baseSystemContent = sysIdx >= 0
    ? (cloneMessages[sysIdx] as { role: string; content: string }).content
    : "";
  const agentPrompt = systemPrompt || baseSystemContent;

  // Combine: Voizo system prefix + agent prompt
  const finalSystemContent = VOIZO_SYSTEM_PREFIX + agentPrompt;

  if (sysIdx >= 0) {
    cloneMessages[sysIdx] = { role: "system", content: finalSystemContent };
  } else {
    cloneMessages.unshift({ role: "system", content: finalSystemContent });
  }

  const clonePayload = {
    name: cloneName,
    model: {
      provider: base.model?.provider ?? "openai",
      model: base.model?.model ?? "gpt-4o",
      maxTokens: base.model?.maxTokens ?? 150,
      messages: cloneMessages,
    },
    voice: cloneVoice,
    transcriber: base.transcriber ?? { provider: "deepgram", model: "flux-general-en", language: "en" },
    firstMessage: base.firstMessage ?? null,
    endCallMessage: base.endCallMessage ?? "Goodbye.",
    endCallFunctionEnabled: base.endCallFunctionEnabled ?? true,
    voicemailMessage: base.voicemailMessage ?? null,
    silenceTimeoutSeconds: 60,
    maxDurationSeconds: base.maxDurationSeconds ?? 202,
    firstMessageMode: base.firstMessageMode ?? "assistant-speaks-first-with-model-generated-message",
    analysisPlan: base.analysisPlan ?? {},
    structuredDataPlan: base.structuredDataPlan ?? undefined,
    voicemailDetection: base.voicemailDetection ?? null,
    server: (() => {
      const baseServer = base.server ?? {};
      const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;
      return {
        url: baseServer.url ?? "https://voizo-eight.vercel.app/api/webhooks/vapi/end-of-call",
        timeoutSeconds: baseServer.timeoutSeconds ?? 20,
        ...(webhookSecret ? { secret: webhookSecret } : {}),
      };
    })(),
    metadata: { voizoClone: true },
  };

  // ── 3. Create clone on Vapi ──
  const createRes = await fetch("https://api.vapi.ai/assistant", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(clonePayload),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error("Vapi clone failed:", errText.slice(0, 500));
    return NextResponse.json(
      { error: `Failed to create cloned assistant: ${errText.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const clone = await createRes.json();

  // ── 4. Create a Vapi SIP phone number pointing to the clone ──
  // Option B (manifesto §8 Reliability): deterministic SIP routing, no webhook
  // in the call path. Each clone gets its own SIP endpoint on sip.vapi.ai.
  const sipUser = `voizo-campaign-${clone.id.slice(0, 8)}`;
  const sipUri = `sip:${sipUser}@sip.vapi.ai`;

  const phoneRes = await fetch("https://api.vapi.ai/phone-number", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      provider: "vapi",
      sipUri,
      assistantId: clone.id,
      name: cloneName,
      authentication: {
        username: sipUser,
        password: sipAuthPassword,
      },
    }),
  });

  if (!phoneRes.ok) {
    const errText = await phoneRes.text();
    console.error("Vapi SIP phone number creation failed:", errText.slice(0, 500));
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    }).catch(() => {});
    return NextResponse.json(
      { error: `Failed to create SIP phone number: ${errText.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const phone = await phoneRes.json();

  return NextResponse.json({
    assistantId: clone.id,
    assistantName: clone.name,
    sipUri: phone.sipUri ?? sipUri,
  });
}
