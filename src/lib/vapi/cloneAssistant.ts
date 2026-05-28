/**
 * createClone — single source of truth for the Voizo Vapi clone payload.
 *
 * Extracted from src/app/api/vapi/clone-assistant/route.ts on 2026-05-18
 * (Phase 1 Step 4b of the dashboard rebuild). Two routes call this:
 *   - POST /api/vapi/clone-assistant (campaign create)
 *   - POST /api/campaigns-v2/[id]/rebind (after eject)
 *
 * The function:
 *   1. Validates input (baseAssistantId length, voiceId KNOWN_VOICES membership,
 *      systemPrompt length).
 *   2. GETs the base assistant from Vapi.
 *   3. Validates voice provider compatibility (11labs-only when operator picks).
 *   4. Composes the clone payload: spread base + apply Voizo runtime safety floor
 *      + per-campaign overrides + system-prompt prefix + strip Vapi-server-set
 *      fields.
 *   5. POSTs to Vapi /assistant.
 *   6. Returns the created clone or a discriminated-union failure.
 *
 * Returns a tagged result rather than throwing — callers translate to whatever
 * response format they need (NextResponse error JSON, etc.).
 *
 * Every runtime override + comment is preserved verbatim from the pre-refactor
 * route handler. Bug-for-bug compatibility is required: existing campaigns'
 * clones and freshly-created clones must be identical post-refactor.
 */

/**
 * ElevenLabs voice catalog the operator can pick from. Used as both an allowlist
 * (request validation) and a display-name source (clone naming). When voiceId is
 * unset, the clone inherits base.voice wholesale (provider + voiceId + every
 * voice knob) — see voice merge logic below.
 */
export const KNOWN_VOICES: Record<string, string> = {
  "3jR9BuQAOPMWUjWpi0ll": "Stephen",
  "UgBBYS2sOqTuMpoF3BR0": "Mark",
  "6YQMyaUWlj0VX652cY1C": "Mark (Natural)",
  "2zGvynULFssveGrcP8hi": "Jackson",
  "YaarrMwvJxVUpjbZ2RpC": "George",
  "pHqSZYhjNK8nDCPRglTL": "Alex",
  "1IthILLNX448pH19aMvC": "Matthew",
  "pNInz6obpgDQGcFmaJgB": "Adam",
};

/**
 * Voizo runtime safety policy — fields the clone MUST have regardless of base.
 *
 * Rationale: clones outlive base edits. Once cloned, a campaign uses its frozen
 * snapshot for the entire run; if Maria/Eva tune the base later, NEW clones get
 * the changes but EXISTING clones don't. Therefore Voizo must own runtime safety
 * (turn-taking determinism, interruption sensitivity, denoising, webhook routing)
 * at clone-creation time. Persona (voice, sales pitch, model choice) stays
 * inherited so Maria/Eva can iterate without code deploys.
 *
 * Values rationale:
 *   - firstMessageMode "assistant-speaks-first": static greeting, no LLM
 *     regeneration on interrupts. Closes Eva's 2026-05-13 loop bug where every
 *     interruption during the opener caused the agent to restart its greeting.
 *   - stopSpeakingPlan numWords=2: customer must say ≥2 words to barge in.
 *     Prevents "Hello?" alone from triggering interrupt + re-prompt loop.
 *   - stopSpeakingPlan voiceSeconds=0.3: needs 0.3s of voice to register as
 *     speech. Buffers against cough/breath/background noise.
 *   - stopSpeakingPlan backoffSeconds=1: agent waits 1s after interruption
 *     before resuming. Sane default pinned for consistency.
 *   - backgroundDenoisingEnabled=true: outbound calls hit noisy backgrounds
 *     (TV, restaurant, car). Denoising lives at assistant ROOT level in Vapi's
 *     API schema (Vapi UI groups it under "Transcriber" but the API field is
 *     at the root). Adversarial review 2026-05-13 flagged a transcriber-nested
 *     placement as CRITICAL risk — kept at root here.
 */
const VOIZO_RUNTIME_POLICY = {
  firstMessageMode: "assistant-speaks-first" as const,
  backgroundDenoisingEnabled: true,
  stopSpeakingPlan: {
    numWords: 2,
    voiceSeconds: 0.3,
    backoffSeconds: 1,
  },
} as const;

/**
 * Voizo system prefix — dev-controlled instructions prepended to every clone's
 * agent prompt. Voizo platform requirements that don't belong on the per-base
 * agent prompt Ernie/Maria configure. Vapi only allows one system message so
 * we concatenate (Chris's architecture: system prompt + agent prompt = 1 prompt).
 */
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
  `4. NOT A REAL PERSON — END IMMEDIATELY: If the FIRST thing you hear contains any`,
  `   of the patterns below, this is NOT a customer. Do NOT give your pitch. Call`,
  `   the endCall function immediately. These recordings cost money per minute and`,
  `   never produce a sale.`,
  `   `,
  `   Voicemail greetings: "leave a message", "after the tone", "voice mail",`,
  `      "voicemail", "can't take your call", "not available", "record your message",`,
  `      "press 1 to leave", "press hash", "you've reached", "this is [name]'s",`,
  `      carrier-branded voicemails ("GAAP voicemail", "Vodafone voicemail", etc.).`,
  `   `,
  `   Carrier intercepts: "number you've dialed is unavailable", "not in service",`,
  `      "call cannot be completed", "has been disconnected", "please check the number".`,
  `   `,
  `   Automated answering systems: "press 1 for English", "press 2 to...", "main menu",`,
  `      "thank you for calling [company], your call is important to us".`,
  `   `,
  `   When in doubt — if the speech sounds like a recording or menu, not a live human`,
  `   responding to your greeting — end the call. False negatives (hanging up on a`,
  `   real customer who happens to say one of these phrases) are rare; false positives`,
  `   (recording the pitch into voicemail) are common and wasteful.`,
  ``,
  `[End System Instructions]`,
  ``,
  ``,
].join("\n");

export interface CreateCloneOverrides {
  /**
   * ElevenLabs voiceId from KNOWN_VOICES. When unset, the clone inherits
   * base.voice as-is (provider + voiceId + every voice knob). When set, only
   * the voiceId field is overridden — provider, stability, similarityBoost,
   * etc. are inherited so per-base voice tuning survives.
   */
  voiceId?: string;
  /**
   * Agent-prompt override. When unset, the base's existing system message
   * content is used. The Voizo platform prefix is always prepended.
   */
  systemPrompt?: string;
  /**
   * Campaign-derived name. Final clone name is campaignName (truncated to 40
   * chars), with an optional " (Voice)" suffix when voiceId is set.
   */
  campaignName?: string;
}

export interface VapiClone {
  id: string;
  name: string;
  [key: string]: unknown;
}

export type CreateCloneResult =
  | { ok: true; clone: VapiClone }
  | { ok: false; status: number; error: string };

/**
 * Create a new Vapi clone of `baseAssistantId` with the given overrides.
 * See module header for behavior contract.
 */
export async function createClone(
  vapiPrivateKey: string,
  baseAssistantId: string,
  overrides: CreateCloneOverrides,
): Promise<CreateCloneResult> {
  // ── Input validation ──
  if (!baseAssistantId || typeof baseAssistantId !== "string" || baseAssistantId.length > 100) {
    return { ok: false, status: 400, error: "baseAssistantId is required" };
  }

  const { voiceId, systemPrompt, campaignName } = overrides;

  if (voiceId && !KNOWN_VOICES[voiceId]) {
    return { ok: false, status: 400, error: "Unknown voiceId" };
  }

  if (systemPrompt && systemPrompt.length > 20_000) {
    return { ok: false, status: 400, error: "systemPrompt too long (max 20,000 chars)" };
  }

  // ── 1. Fetch base assistant from Vapi ──
  const baseRes = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(baseAssistantId)}`, {
    headers: { Authorization: `Bearer ${vapiPrivateKey}`, Accept: "application/json" },
    cache: "no-store",
  });

  if (!baseRes.ok) {
    const errText = await baseRes.text();
    return {
      ok: false,
      status: baseRes.status === 404 ? 400 : 502,
      error: `Failed to fetch base assistant: ${errText.slice(0, 200)}`,
    };
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
    return {
      ok: false,
      status: 400,
      error:
        `Base assistant uses voice provider "${baseProvider}" but the operator-selectable ` +
        `voice list is ElevenLabs-only. Either pick a base assistant with provider="11labs" ` +
        `or use the base's own voice (don't pick one in the form).`,
    };
  }
  const cloneVoice = voiceId
    ? { ...base.voice, voiceId }
    : base.voice;

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
    // ── Voizo runtime safety floor (non-negotiable, base can't override) ──
    // See VOIZO_RUNTIME_POLICY definition above for per-field rationale.
    // This spread MUST come before the per-campaign overrides so that name/
    // voice/model overrides still win for their own fields, but the safety
    // floor wins over base for firstMessageMode and stopSpeakingPlan.
    ...VOIZO_RUNTIME_POLICY,
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
    // silenceTimeoutSeconds=30 (lowered from 60 on 2026-05-11). The 60-second
    // value was originally set to give Ernie's pitch time to breathe and avoid
    // "call cut short mid-pitch" complaints. After Eva's 2026-05-11 voicemail
    // test showed a $0.10 call where the agent pitched into voicemail and then
    // waited 60s of silence, the trade-off changed: half of that wasted minute
    // can be reclaimed by tightening the silence window. 30s still covers a
    // normal customer pause to consider an offer (typically 5-15s) without
    // cutting off thinking time. Combined with rule #4 in the system prompt
    // (end call on voicemail/intercept patterns), this caps voicemail-cost
    // worst case at ~$0.05 per missed-detection call.
    silenceTimeoutSeconds: 30,
    // ── Hard cap call duration (cost guardrail, 2026-05-15) ──
    // Stakeholder-mandated 3-minute ceiling on any single call. Base agents
    // inherited 202s (most) or 338s (Ernie) from Vapi-side configuration,
    // which silently exceeded the policy ceiling. Override here so every
    // new clone enforces 180s regardless of what's on the base. Pairs with
    // silenceTimeoutSeconds and endCallPhrases as the third leg of the
    // wrong-number-loop cost guardrail (per project_cost_runaway_wrongnumbers
    // memory: unconfigured caps let wrong numbers cost $0.15/call for 3-min
    // carrier loops).
    maxDurationSeconds: 180,
    // ── End-call phrase triggers (cost guardrail, 2026-05-28) ──
    // Final leg of the three-part wrong-number cost guardrail. Vapi auto-ends
    // the call when the customer's transcribed speech contains one of these
    // phrases -- saving the ~5-10s of tail-end agent talk that would otherwise
    // occur as the agent composes a goodbye. Pairs with maxDurationSeconds
    // (hard cap), silenceTimeoutSeconds (dead-air cap), and system-prompt
    // rule #4 (voicemail/intercept detection).
    //
    // Phrase selection rationale (Slow-and-Correct pick, 2026-05-28):
    //   - Only goodbye-variant phrases. NO opt-out phrases ("don't call again",
    //     "stop calling", "not interested") -- those would trip Vapi to cut
    //     the call before Rule #3 in VOIZO_SYSTEM_PREFIX (acknowledge opt-out
    //     respectfully) can fire, and several are too mid-sentence-ambiguous
    //     for safe auto-cut ("I was not interested before, but..."). Revisit
    //     if/when programmatic opt-out scrubbing into suppression_list lands.
    //   - Multi-word phrases preferred -- single-word tokens ("bye", "stop")
    //     have too many false-positive substrings in natural speech ("by the
    //     way", "stop sign", "buy this").
    //   - Voizo REPLACES base's endCallPhrases. Matches the existing pattern
    //     for cost-guardrail fields above (silenceTimeoutSeconds,
    //     maxDurationSeconds, voicemailMessage): Voizo owns runtime cost
    //     guardrails; base assistants own persona.
    endCallPhrases: [
      "goodbye",
      "good bye",
      "have a good day",
      "have a great day",
      "have a nice day",
      "have a wonderful day",
      "thank you for calling",
      "talk to you later",
      "take care",
    ],
    // ── Silent hangup on voicemail (compliance + cost, 2026-05-15) ──
    // When Vapi's voicemail detection fires, it speaks `voicemailMessage` at
    // the beep before ending. The inherited base value ("Please call back
    // when you're available.") risks (1) leaving a pre-recorded sales-adjacent
    // message which crosses into TCPA/CRTC pre-recorded-message consent
    // territory, and (2) burns ~2-3s of billable Vapi time per voicemail-hit
    // call. Empty string = Vapi detects voicemail, ends silently. Customer
    // still sees the missed call and can call back via the carrier-side
    // caller ID. Verified accepted by Vapi via 2026-05-15 throwaway clone test.
    voicemailMessage: "",
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
    // Cost projection:
    //   - Detection catches (target case): ~$0.01 per voicemail (brief message)
    //   - Detection misses: ~$0.08 (today's baseline, unchanged)
    //   - At 20 players × 30% voicemail rate, ~$0.06 worst case. Bounded.
    //
    // Existing clones keep base config until deleted/recreated. This override
    // only applies to NEW campaigns created after deploy.
    //
    // Provider default (added 2026-05-14 hotfix): the comment above says "Vapi
    // voicemail detection IS enabled on base assistants" — that's true for
    // ~12 of 17 production base agents but NOT all. Verified 2026-05-14:
    // Gisela, Janice, Nikhilesh, Alex, Meny have no voicemailDetection field
    // at all. For those bases, the spread `...(base.voicemailDetection ?? {})`
    // yields an empty object, and our backoffPlan override produces a
    // {backoffPlan:{...}} payload missing the required `provider` field. Vapi
    // rejects with 400: "voicemailDetection.an unknown value was passed to
    // the validate function". The explicit `provider` default below ensures
    // every clone's voicemailDetection is a valid Vapi payload regardless of
    // whether the base has voicemailDetection configured. Bases that already
    // have provider="vapi" inherit it via the ?? chain (no behavior change);
    // bases without voicemailDetection now get provider="vapi" added (clone
    // gains voicemail detection where the base lacked it — aligned with the
    // original commit's intent of "tighter voicemail detection on cloned
    // assistants" applying platform-wide).
    //
    // beepMaxAwaitSeconds override (2026-05-15): production diagnostic across
    // 173 calls in 14 days showed ZERO calls with endedReason=voicemail despite
    // the backoffPlan tightening shipped 2026-05-11. Root cause: base agents
    // have beepMaxAwaitSeconds=0, which disables Vapi's wait-for-beep step.
    // Without that wait, the detection chain never completes — AMD fires but
    // Vapi never plays voicemailMessage, never sets endedReason=voicemail, and
    // the call continues until the LLM agent itself detects voicemail content
    // via prompt rule #4 and calls endCall. That LLM-detection path works but
    // burns ~8-15s of agent talk into voicemail before realizing. Setting
    // beepMaxAwaitSeconds=30 (Vapi's documented default) lets the detection
    // complete properly so Vapi can intercept on detection rather than relying
    // on the LLM fallback. Verified accepted by Vapi via 2026-05-15 throwaway
    // clone test.
    voicemailDetection: {
      ...(base.voicemailDetection ?? {}),
      provider: base.voicemailDetection?.provider ?? "vapi",
      beepMaxAwaitSeconds: 30,
      backoffPlan: {
        ...((base.voicemailDetection ?? {}).backoffPlan ?? {}),
        startAtSeconds: 3,
        frequencySeconds: 2.5,
        maxRetries: 6,
      },
    },
    // ── Webhook server config: PIN to Voizo's URL (no fallback to base) ──
    // Previously fell back to base.server.url if set, allowing Maria's test
    // webhook URLs to silently capture clone end-of-call events. Voizo must
    // own webhook routing — base authority over this field was a footgun.
    // Without the end-of-call reaching Voizo, goal_reached never sets, SMS
    // never dispatches, and the call shows "completed" forever with no
    // outcome on the dashboard.
    //
    // URL resolution (2026-05-26): the URL is now env-driven via
    // VAPI_WEBHOOK_URL with the prod URL as a fallback. This lets us route
    // new clones' end-of-call events to a Vercel preview deployment when we
    // need to verify webhook-handler code changes BEFORE merging to main.
    // Without this, the previous hard-pin meant preview-deployment dashboards
    // still routed their clones' webhooks to prod, masking webhook bugs that
    // only surfaced after main was merged. The env var is operator-controlled
    // (not assistant-config-controlled), so the original threat model — base
    // assistants overriding our webhook URL via their own server config — is
    // unchanged. Set VAPI_WEBHOOK_URL in Vercel's Preview env scope only;
    // never in Production env (production should always use the prod URL
    // via the explicit default below).
    server: (() => {
      const webhookSecret = process.env.VAPI_WEBHOOK_SECRET;
      const webhookUrl =
        process.env.VAPI_WEBHOOK_URL ??
        "https://voizo-eight.vercel.app/api/webhooks/vapi/end-of-call";
      return {
        url: webhookUrl,
        timeoutSeconds: 20,
        ...(webhookSecret ? { secret: webhookSecret } : {}),
      };
    })(),
    // ── Voizo identifier (preserve base metadata, add our marker) ──
    // Previously wholesale-replaced base.metadata, dropping any team/lifecycle
    // tags Maria set on the base. Merge preserves base.metadata while ensuring
    // our voizoClone marker is always present for the assistant-picker filter.
    metadata: { ...(base.metadata ?? {}), voizoClone: true },
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
      Authorization: `Bearer ${vapiPrivateKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(clonePayload),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    console.error("Vapi clone failed:", errText.slice(0, 500));
    return {
      ok: false,
      status: 502,
      error: `Failed to create cloned assistant: ${errText.slice(0, 200)}`,
    };
  }

  const clone = (await createRes.json()) as VapiClone;
  return { ok: true, clone };
}
