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
  const cloneName = withVoice.length <= 40 ? withVoice : baseName.slice(0, 40);

  // Voice merge: when operator picks a voice, swap only the voiceId; inherit
  // every other voice knob (provider, model, stability, similarityBoost,
  // optimizeStreamingLatency, enableSsmlParsing, future Vapi voice fields)
  // from the base assistant. Replacing the whole object wholesale was the
  // root cause of mispronunciation (SSML disabled), wrong cadence (turbo
  // model + stability 0.85 forced over base tuning), and "two voices in a
  // call" symptoms — base startSpeakingPlan still spread, but voice timing
  // was no longer aligned. See .agent/handoffs/2026-05-07_HANDOFF_Clone_Drift_Investigation.md §5.1
  //
  // Provider guard: KNOWN_VOICES is 11labs-only today. If the base assistant
  // ever uses a non-11labs provider (azure/playht/cartesia/rime), spreading
  // base.voice and overlaying an 11labs voiceId produces a hybrid that Vapi
  // rejects (or worse, silently breaks audio). Refuse early with a clear
  // operator-facing error.
  const baseProvider = base.voice?.provider as string | undefined;
  if (voiceId && baseProvider && baseProvider !== "11labs") {
    return NextResponse.json(
      {
        error:
          `Base assistant uses voice provider "${baseProvider}" but the operator-selectable ` +
          `voice list is ElevenLabs-only. Either pick a base assistant with provider="11labs" ` +
          `or use the base's own voice (don't pick one in the form).`,
      },
      { status: 400 },
    );
  }
  const cloneVoice = voiceId
    ? { ...base.voice, voiceId }
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

  // ── Clone payload: spread-base, override surgically ──
  // Previously this was a field-by-field whitelist that silently dropped any
  // base assistant fields not explicitly listed (backgroundDenoisingEnabled,
  // model.temperature, startSpeakingPlan, voice sub-settings, transcriber.keyterm,
  // etc.). Result: clones drifted from base behavior in invisible ways.
  //
  // New approach: spread `base` entirely so every field Chris configures on the
  // base assistant (Keyterms, Denoising, Smart Endpointing, model temperature,
  // tools, future Vapi additions) inherits automatically. Override only what
  // MUST be different per campaign (name, operator-chosen voice, system prompt,
  // Voizo's runtime knobs, our webhook server). Strip Vapi-server-set fields
  // that POST /assistant rejects (id, orgId, createdAt, updatedAt).
  const clonePayload = {
    ...base,
    // ── Per-campaign overrides ──
    name: cloneName,
    voice: cloneVoice,
    model: {
      ...base.model,
      messages: cloneMessages,
      // Defaults if base.model is undefined entirely (defensive)
      provider: base.model?.provider ?? "openai",
      model: base.model?.model ?? "gpt-4o",
      maxTokens: base.model?.maxTokens ?? 150,
    },
    // ── Voizo-mandated runtime knobs ──
    // silenceTimeoutSeconds=60 is RESTORED as an explicit override after the
    // post-launch audit (2026-05-07): the previous "delegate to base" approach
    // (commit 25af55f) had no enforcement, so a forgotten Vapi UI step would
    // silently regress to Vapi's ~26s default and re-introduce Ernie's
    // "call cut short mid-pitch" bug. Hardcoding here is a Voizo-platform
    // guarantee, not an opinion that should be tunable per base assistant.
    // If a future use case needs a different value, expose it as a campaign
    // setting in the form rather than removing the override.
    silenceTimeoutSeconds: 60,
    // ── Voicemail detection tuning (Maria's request 2026-05-09 — cost guard) ──
    // Eva's 2026-05-08 test recorded the agent giving its full sales pitch on
    // Maria's Gibraltar voicemail (~$0.08/call wasted, capped only by the 60s
    // silenceTimeoutSeconds above). Vapi voicemail detection IS enabled on base
    // assistants (provider="vapi") with a brief voicemailMessage already set,
    // but the default backoff plan (startAtSeconds=5, frequencySeconds=2.5,
    // maxRetries=4) missed Eva's 15s Gibraltar greeting.
    //
    // Conservative tightening — only the backoff plan changes:
    //   - startAtSeconds: 3 (was 5) — start sooner without going below the
    //     documented safe minimum. Gibraltar/UK voicemail greetings start
    //     speaking within the first 1-2 seconds.
    //   - frequencySeconds: 2.5 (unchanged from base) — Vapi enforces a hard
    //     minimum of 2.5 on this field (verified by 400 response 2026-05-09
    //     "frequencySeconds must not be less than 2.5"). We can't go lower
    //     even if we wanted to without Vapi rejecting the entire clone POST.
    //   - maxRetries: 6 (was 4) — detection window now 3-15.5s, covers the
    //     15s greeting that defeated the old config.
    //
    // Deliberately NOT touching voicemailMessage. The base value ("Please call
    // back when you're available.") is inherited via ...base, and overriding
    // it to null/empty risks Vapi's class-validator rejecting the entire
    // clone POST — which would break all new campaign creation.
    //
    // Cost projection:
    //   - Detection catches (target case): ~$0.01 per voicemail (brief message)
    //   - Detection misses: ~$0.08 (today's baseline, unchanged)
    //   - At 20 players × 30% voicemail rate, ~$0.06 worst case. Bounded.
    //
    // Existing clones keep base config until deleted/recreated. This override
    // only applies to NEW campaigns created after deploy.
    voicemailDetection: {
      ...(base.voicemailDetection ?? {}),
      backoffPlan: {
        ...((base.voicemailDetection ?? {}).backoffPlan ?? {}),
        startAtSeconds: 3,
        frequencySeconds: 2.5,
        maxRetries: 6,
      },
    },
    // ── Webhook server config (must point at our endpoint with our secret) ──
    server: (() => {
      const baseServer = base.server ?? {};
      const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;
      return {
        url: baseServer.url ?? "https://voizo-eight.vercel.app/api/webhooks/vapi/end-of-call",
        timeoutSeconds: baseServer.timeoutSeconds ?? 20,
        ...(webhookSecret ? { secret: webhookSecret } : {}),
      };
    })(),
    // ── Voizo identifier (for assistant-picker filter on campaign creation) ──
    metadata: { voizoClone: true },
    // ── Strip Vapi-server-set fields (POST /assistant rejects these) ──
    id: undefined,
    orgId: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    // Defensive: associations don't transfer; each clone gets its own SIP phone
    phoneNumberIds: undefined,
    isServerUrlSecretSet: undefined,
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
