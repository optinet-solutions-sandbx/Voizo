// Shared end-of-call-report processing (VOZ-157).
//
// Extracted VERBATIM from src/app/api/webhooks/vapi/end-of-call/route.ts so
// BOTH the agent-mode end-of-call route AND the Phase-2 script-call route
// (VOZ-158) run identical downstream logic: call matching, goal_reached eval,
// outcomes, opt-out suppression, Mobivate SMS, recording URL. Behavior is
// bug-for-bug identical to the pre-refactor inline route body — the only
// change is that the code lives here and takes `message` as a parameter.
//
// The caller is responsible for auth (x-vapi-secret) and for filtering to
// message.type === "end-of-call-report" before calling this.
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { isVoicemail, hasGenuineCustomerConsent, hasRealConversation, agentMentionedSms, customerDeclinedSms, customerRequestedCallback, customerRiskDisclosure } from "@/lib/transcriptClassify";
import { postSlackAlert } from "@/lib/alerts/slack";
import { decideSmsDispatch, resolveSmsConsentMode, type SmsConsentMode } from "@/lib/smsDispatchDecision";
import { fireCallFollowup } from "@/lib/followupEvent";
import { decideOutcomePark } from "@/lib/webhooks/hangupOutcome";
import { deriveAttemptTag } from "@/lib/dashboardAnalytics";
import { resolveCallCosts, type VapiCostPayload } from "@/lib/callCost";

export async function processEndOfCall(message: Record<string, unknown>): Promise<NextResponse> {
  const vapiCall = message.call as Record<string, unknown> | undefined;
  const vapiCallId = vapiCall?.id as string | undefined;
  const transcript = message.transcript as string | undefined;
  const analysis = message.analysis as Record<string, unknown> | undefined;

  // Diagnostic: log the full analysis payload on every end-of-call.
  // Critical for debugging the "analysis never runs" issue (all 45 calls
  // returned analysis:{} as of 2026-04-30). Remove once analysis is stable.
  console.log(
    `[vapi end-of-call] payload: ` +
    JSON.stringify({
      vapiCallId,
      customer: vapiCall?.customer || null,
      phoneCallProviderId: vapiCall?.phoneCallProviderId || null,
      analysis: analysis || null,
      analysisKeys: analysis ? Object.keys(analysis) : [],
      hasTranscript: Boolean(transcript),
    }),
  );

  // Temporary diagnostic for Vapi support ticket — full call object inspection.
  // Requested by Vapi Composer to determine if analysisPlan is present on the
  // call object in the webhook payload. Remove once Vapi resolves the issue.
  //
  // Artifact-path note (2026-05-26): Vapi's end-of-call-report webhook payload
  // delivers `artifact` as a sibling of `message.call`, NOT nested inside it.
  // The earlier `vapiCall?.artifact` binding yielded undefined for every real
  // webhook (visible only in the silent NULL recording_url writes after Phase 1
  // shipped). Read `message.artifact` first; keep `vapiCall.artifact` as a
  // fallback in case Vapi ever ships the alternate shape — confirmed empirically
  // against an API-fetched call object where artifact IS on the call.
  const artifact = (message.artifact ?? vapiCall?.artifact) as Record<string, unknown> | undefined;
  console.log(
    `[vapi-diag] call-object: ` +
    JSON.stringify({
      callKeys: vapiCall ? Object.keys(vapiCall) : [],
      artifactKeys: artifact ? Object.keys(artifact) : [],
      meta: {
        id: vapiCallId,
        type: vapiCall?.type,
        endedReason: vapiCall?.endedReason,
        assistantId: vapiCall?.assistantId,
        phoneNumberId: vapiCall?.phoneNumberId,
        messagesLen: Array.isArray(vapiCall?.messages) ? (vapiCall.messages as unknown[]).length : undefined,
        artifactMessagesLen: Array.isArray(artifact?.messages) ? (artifact.messages as unknown[]).length : undefined,
        hasTranscript: Boolean(artifact?.transcript || transcript),
        analysisKeys: analysis ? Object.keys(analysis) : [],
        hasAnalysisPlan: vapiCall?.analysisPlan ? true : false,
      },
    }),
  );

  // ── Voicemail + success evaluation ──
  // `voicemailDetected` (the strengthened, shared `isVoicemail`) is used both by
  // the goal_reached veto below and by the outcome-routing block further down.
  const voicemailDetected = transcript ? isVoicemail(transcript) : false;

  // Vapi's successEvaluation can be string | boolean | number | null (June 2025
  // breaking change). Handle all variants defensively.
  const successEval = analysis?.successEvaluation;
  const nativeSuccess = successEval === true || successEval === "true";
  let goalReached = nativeSuccess;

  // (d) Source-agnostic voicemail veto (2026-06-04): a voicemail is never a
  // success, even if a base assistant's native successEvaluation returned true.
  if (goalReached && voicemailDetected) {
    goalReached = false;
    console.log(`[goal-eval] goal_reached dropped — voicemail detected (source-agnostic veto). vapiCallId=${vapiCallId}`);
  }

  // (b) Transcript fallback (2026-06-04): Vapi's native analysis is empty on our
  // SIP calls, so we evaluate the transcript — but require a GENUINE, machine-
  // screened CUSTOMER consent (`hasGenuineCustomerConsent`), never the agent's
  // own scripted line. This replaces the prior agent-phrase patterns, which
  // fired on voicemails / STT fragments ("Message.") and produced false
  // successes + unconsented SMS. Validated 2026-06-04 (n=982; 0 real-campaign loss).
  if (successEval == null && transcript && !goalReached && !voicemailDetected) {
    if (hasGenuineCustomerConsent(transcript)) {
      goalReached = true;
      console.log(`[fallback-eval] goal_reached=true via genuine customer consent. vapiCallId=${vapiCallId}`);
    }
  }

  // Opt-out signal: Vapi assistant outputs structuredData.optOut when the
  // contact explicitly asks not to be called again.
  const structuredData = analysis?.structuredData as Record<string, unknown> | undefined;
  let optedOut =
    structuredData?.optOut === true || structuredData?.optOut === "true";

  // ── Fallback: transcript-based opt-out detection ──
  // Same Vapi analysis bug means structuredData is always undefined.
  // Scan transcript for explicit customer opt-out requests.
  //
  // Compliance note: missing an opt-out is worse than a false positive.
  // A false positive just suppresses a number (safe). A false negative
  // means we keep calling someone who asked to stop (compliance risk).
  // So we detect on customer signals alone — no AI confirmation required.
  //
  // Vapi's structuredData takes priority when present.
  // 2026-06-11 (review C1): the scan now runs whenever structuredData didn't
  // already flag — previously gated on successEval == null, which let a missed
  // LLM extraction ("stop calling me" present, analysis ran but optOut absent)
  // reach the registered_optin SMS dispatch with optedOut=false. Missing an
  // opt-out is worse than a false positive (see compliance note above).
  if (transcript && !optedOut) {
    const stopCalls = /(?:don'?t|do not|stop|never) (?:call|contact|phone)/i.test(transcript);
    const removeMe = /(?:remove|take) (?:me|my (?:number|phone)) (?:off|from|out)/i.test(transcript);

    if (stopCalls || removeMe) {
      optedOut = true;
      console.log(
        `[fallback-eval] opted_out=true via transcript pattern ` +
        `(Vapi analysis missing, customer requested no more calls). vapiCallId=${vapiCallId}`,
      );
    }
  }

  // ── Responsible-gambling disclosure (2026-08-28) ──
  // Measured over all 22,041 prod transcripts: six customers disclosed self-exclusion, a
  // gambling addiction or self-harm, and THREE were sent a promotional SMS afterwards.
  // Nothing was looking for it — the two that WERE suppressed were suppressed by accident,
  // because the agent's own reply matched the opt-out regexes above (which scan AI turns).
  //
  // Routed through `optedOut` deliberately, because that single flag already does every
  // thing this needs and is already tested: decideSmsDispatch refuses in EVERY mode on its
  // first line, decideOutcomePark returns null (no retry park), the outcome becomes
  // terminal, and the block further down writes suppression_list so the dialer never picks
  // the number again. Reusing it is a smaller and safer change than a parallel path.
  const riskDisclosure = transcript ? customerRiskDisclosure(transcript) : null;
  if (riskDisclosure) {
    optedOut = true;
    console.log(
      `[risk-disclosure] category=${riskDisclosure.category} — SMS vetoed, number suppressed. ` +
      `vapiCallId=${vapiCallId} excerpt="${riskDisclosure.excerpt}"`,
    );
    // Alert BEFORE any DB work and never awaited into the failure path: a human must see a
    // harm disclosure even if every subsequent write fails. A Slack outage must not break
    // the webhook, so the promise is caught and dropped.
    // Severity stays "ALERT" — the union is INFO|WARN|ALERT and widening a shared type for
    // one caller is not worth it; the TITLE carries the urgency, which is what a reader sees.
    void postSlackAlert(
      "ALERT",
      riskDisclosure.category === "harm"
        ? "URGENT — customer disclosed self-harm on a call, a human needs to read this now"
        : `Customer disclosed ${riskDisclosure.category.replace("_", " ")} — call and SMS stopped`,
      [
        `The customer said: "${riskDisclosure.excerpt}"`,
        `Vapi call ${vapiCallId}. The SMS was refused and the number is being added to the suppression list, so we will not call or text it again.`,
        riskDisclosure.category === "harm"
          ? "Read the transcript and decide whether the operator needs to be told. Automated handling stops here on purpose."
          : "Marketing to a self-excluded or self-declared problem gambler is the breach — check whether this player should also be flagged in the CRM so we never load them again.",
      ],
    ).catch((err) => console.error("[risk-disclosure] Slack alert failed (handling continues):", err));
  }

  // ── Match to our calls_v2 record (H1 fix: reliable matching) ──
  // Strategy: match by vapi_call_id first, then by phoneCallProviderId (Twilio SID)
  let callRow: Record<string, unknown> | null = null;

  // 1. Try vapi_call_id (if we already stored it)
  if (vapiCallId) {
    const { data } = await supabaseAdmin
      .from("calls_v2")
      .select("*")
      .eq("vapi_call_id", vapiCallId)
      .maybeSingle();
    callRow = data;
  }

  // 2. Try Twilio SID from Vapi's phoneCallProviderId
  if (!callRow) {
    const providerCallId = vapiCall?.phoneCallProviderId as string | undefined;
    if (providerCallId) {
      const { data } = await supabaseAdmin
        .from("calls_v2")
        .select("*")
        .eq("provider_call_id", providerCallId)
        .maybeSingle();
      callRow = data;
    }
  }

  // 3. Fallback: match by customer phone + recent + no vapi_call_id yet.
  //
  // Why: when the call goes through FreeSWITCH (DIALER_PROVIDER=freeswitch),
  // calls_v2.provider_call_id stores the FS Job UUID, which Vapi has no
  // visibility into. Vapi's phoneCallProviderId is a SIP-side identifier in
  // a different namespace, so strategy #2 never matches for FS calls.
  // calls_v2.vapi_call_id is null at originate time (we only learn Vapi's
  // call id from this very webhook), so #1 also misses on the first event.
  //
  // This fallback closes the gap: if Vapi's payload includes the customer
  // phone number, we look up the most recent calls_v2 row for that phone
  // that hasn't been linked to a Vapi call yet, scoped to a 15-minute window
  // (well over the 3-minute call cap, well under any realistic ambiguity
  // from a second concurrent call to the same number).
  //
  // 3b. SIP URI suffix matching — when customer.number is missing, some
  // carriers (e.g. SquareTalk GI routes) prepend routing prefixes to the
  // SIP URI user part (e.g. "sip:99900134637534739@..." for +34637534739).
  // We extract the digits from the SIP URI and suffix-match against campaign
  // numbers to handle arbitrary carrier prefixes.
  if (!callRow) {
    const customer = vapiCall?.customer as Record<string, unknown> | undefined;
    const customerNumber = typeof customer?.number === "string" ? customer.number : null;

    if (customerNumber) {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

      const { data: numberRows } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("id")
        .eq("phone_e164", customerNumber);

      if (numberRows && numberRows.length > 0) {
        const numberIds = numberRows.map((r) => r.id as string);
        const { data } = await supabaseAdmin
          .from("calls_v2")
          .select("*")
          .in("campaign_number_id", numberIds)
          .is("vapi_call_id", null)
          .gte("created_at", fifteenMinutesAgo)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (data) {
          callRow = data;
          console.log(
            `Vapi end-of-call: matched by customer-phone fallback ` +
            `(phone=${customerNumber.slice(0, -4)}**** callId=${data.id} vapiCallId=${vapiCallId})`,
          );
        }
      }
    }

    // 3b: SIP URI suffix matching — carrier prefixes make exact match fail.
    // Extract digits from the SIP user part and find a campaign number whose
    // E.164 digits are a suffix of the SIP digits.
    // Example: SIP "99900134637534739" ends with "34637534739" → matches "+34637534739"
    if (!callRow && typeof customer?.sipUri === "string") {
      const sipMatch = customer.sipUri.match(/^sip:([^@]+)@/);
      if (sipMatch) {
        const sipDigits = sipMatch[1].replace(/[^0-9]/g, "");

        if (sipDigits.length >= 8) {
          const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();

          // Get recent unlinked calls within the time window
          const { data: recentCalls } = await supabaseAdmin
            .from("calls_v2")
            .select("*, campaign_number_id")
            .is("vapi_call_id", null)
            .gte("created_at", fifteenMinutesAgo)
            .order("created_at", { ascending: false })
            .limit(20);

          if (recentCalls && recentCalls.length > 0) {
            const numberIds = [...new Set(recentCalls.map((c) => c.campaign_number_id as string))];
            const { data: numberRows } = await supabaseAdmin
              .from("campaign_numbers_v2")
              .select("id, phone_e164")
              .in("id", numberIds);

            if (numberRows) {
              // Suffix match: does the SIP digits string end with the E.164 digits?
              const matched = numberRows.find((n) => {
                const e164Digits = (n.phone_e164 as string).replace(/[^0-9]/g, "");
                return sipDigits.endsWith(e164Digits);
              });

              if (matched) {
                const matchedCall = recentCalls.find((c) => c.campaign_number_id === matched.id);
                if (matchedCall) {
                  callRow = matchedCall;
                  console.log(
                    `Vapi end-of-call: matched by SIP URI suffix fallback ` +
                    `(sipDigits=${sipDigits} phone=${(matched.phone_e164 as string).slice(0, -4)}**** ` +
                    `callId=${matchedCall.id} vapiCallId=${vapiCallId})`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  if (!callRow) {
    console.warn("Vapi end-of-call: no matching call record found", { vapiCallId });
    return NextResponse.json({ received: true, matched: false });
  }

  // ── Idempotency check (C4 fix: don't process same call twice) ──
  if (callRow.goal_reached !== null) {
    return NextResponse.json({ received: true, idempotent: "already processed" });
  }

  // Extract recording URL from Vapi's artifact (canonical path) with legacy
  // fallback. Persisted to calls_v2.recording_url for the export feature
  // (avoids per-call Vapi API re-fetches at export time per Vapi support's own
  // recommendation). The deprecated top-level recordingUrl actually lives at
  // `artifact.recordingUrl` in the webhook payload (sibling of `recording`),
  // not on the call object — verified 2026-05-26 against a real PH test call.
  const recordingMono = (artifact?.recording as Record<string, unknown> | undefined)?.mono as Record<string, unknown> | undefined;
  let recordingUrl: string | null =
    (typeof recordingMono?.combinedUrl === "string" ? recordingMono.combinedUrl : null) ??
    (typeof artifact?.recordingUrl === "string" ? (artifact.recordingUrl as string) : null);

  // Async-race fallback (2026-05-26): Vapi serializes the end-of-call-report
  // payload at the moment the call ENDS, then asynchronously uploads the
  // recording to storage.vapi.ai over the following ~3-10 seconds. For short
  // calls especially, the recording isn't ready by the time Vapi snapshots
  // the webhook body — so the URL is missing from the payload we receive,
  // even though it lands in storage seconds later. Empirically verified
  // 2026-05-26 against a 26-second test call: recording uploaded 5.3s
  // after call-end; our handler ran 8s after call-end; payload URL was
  // null but the GET /call/{id} API returned all three URL paths populated.
  //
  // Fallback: when the webhook payload lacks the URL and we have vapiCallId,
  // fetch the call object once. ~200ms latency; only triggers on miss; well
  // within the 20s webhook timeout configured in cloneAssistant.ts. Failure
  // is logged and non-fatal — the rest of the UPDATE proceeds without a URL.
  // Unconditional diagnostic (2026-05-26 commit 9): logs the runtime state at
  // the moment of the re-fetch decision so we can see why the fallback may be
  // silently skipping. Observed in prod: artifact was empty, vapiCallId was
  // present, but no [end-of-call] markers appeared in logs — pointing at the
  // `if (vapiKey)` check returning false. This line tells us definitively
  // whether process.env.VAPI_PRIVATE_KEY is accessible in the webhook function's
  // runtime. Remove after diagnosis is complete.
  console.log(
    `[end-of-call-debug] pre-refetch: hasRecordingUrl=${Boolean(recordingUrl)} ` +
    `vapiCallId=${vapiCallId ?? "missing"} ` +
    `hasVapiKey=${Boolean(process.env.VAPI_PRIVATE_KEY)} ` +
    `vapiKeyLen=${(process.env.VAPI_PRIVATE_KEY ?? "").length}`,
  );

  if (!recordingUrl && vapiCallId) {
    const vapiKey = process.env.VAPI_PRIVATE_KEY;
    if (!vapiKey) {
      console.error(
        `[end-of-call] VAPI_PRIVATE_KEY missing at webhook runtime — ` +
        `recording URL recovery disabled. Cron /api/cron/recording-backfill ` +
        `will retry. vapiCallId=${vapiCallId}`,
      );
    } else {
      try {
        const refetch = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(vapiCallId)}`, {
          headers: { Authorization: `Bearer ${vapiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (refetch.ok) {
          const callObj = await refetch.json() as Record<string, unknown>;
          const objArtifact = callObj.artifact as Record<string, unknown> | undefined;
          const objMono = (objArtifact?.recording as Record<string, unknown> | undefined)?.mono as Record<string, unknown> | undefined;
          recordingUrl =
            (typeof objMono?.combinedUrl === "string" ? objMono.combinedUrl : null) ??
            (typeof objArtifact?.recordingUrl === "string" ? (objArtifact.recordingUrl as string) : null);
          if (recordingUrl) {
            console.log(`[end-of-call] recording URL recovered via API re-fetch for call ${vapiCallId}`);
          }
        } else {
          console.warn(`[end-of-call] vapi re-fetch returned ${refetch.status} for call ${vapiCallId}`);
        }
      } catch (err) {
        console.warn(`[end-of-call] vapi recording re-fetch failed for call ${vapiCallId}:`, err);
      }
    }
  }

  // ── Update calls_v2 with transcript, goal_reached, recording_url + observability signals ──
  // Hoisted (2026-08-07) so the optin_reached_only attempt-tag below reads the
  // SAME values this update persists — dispatch classifies exactly what the
  // dashboard will later read back.
  const endedReason = (message.endedReason ?? vapiCall?.endedReason ?? null) as string | null;
  const durationSeconds =
    typeof callRow.duration_seconds === "number"
      ? callRow.duration_seconds
      : typeof message.durationSeconds === "number"
        ? (message.durationSeconds as number)
        : null;
  await supabaseAdmin
    .from("calls_v2")
    .update({
      vapi_call_id: vapiCallId || null,
      transcript: transcript ? { text: transcript } : null,
      goal_reached: goalReached,
      recording_url: recordingUrl,
      // Observability (received earlier in this handler but previously discarded): Vapi's
      // conversation-leg end reason, and our transcript-based voicemail flag. voicemailDetected
      // (not vapiCall.endedReason) is the source of truth for voicemail — Vapi rarely sets
      // endedReason='voicemail' on our SIP calls (see cloneAssistant.ts beepMaxAwaitSeconds note).
      // Artifact-path bug (2026-06-22): like `artifact` (see ~line 92), the end-of-call-report
      // delivers `endedReason` as a sibling of `message.call`, NOT nested inside it. Reading
      // `vapiCall.endedReason` (= message.call.endedReason) yielded null for 115/115 real calls
      // while the Vapi API had a real reason (assistant-ended-call/silence-timed-out/…). Read
      // `message.endedReason` first; keep `vapiCall.endedReason` as a fallback for the alt shape.
      ended_reason: endedReason,
      voicemail: voicemailDetected,
      // Budget guardrail (2026-08-04): per-call cost ingestion. Same message-
      // level-first read as endedReason/artifact above (report fields live as
      // siblings of message.call). Missing cost stays NULL — the recording-
      // backfill cron sweeps NULL vapi_cost_usd via the Vapi API. OpenAI side
      // is computed (tokens when rates configured, else measured $/talk-min);
      // duration may not be written yet (FS hangup webhook races this one), so
      // fall back to Vapi's own durationSeconds for the estimate basis.
      ...(() => {
        const costPayload: VapiCostPayload = {
          cost: (message.cost ?? vapiCall?.cost) as number | null | undefined,
          costBreakdown: (message.costBreakdown ?? vapiCall?.costBreakdown) as VapiCostPayload["costBreakdown"],
        };
        const costs = resolveCallCosts(costPayload, durationSeconds);
        return { vapi_cost_usd: costs.vapiCostUsd, openai_cost_usd: costs.openaiCostUsd };
      })(),
    })
    .eq("id", callRow.id);

  // ── Campaign SMS config + mode-aware dispatch decision (2026-06-11) ──
  // Fetched BEFORE the outcome update because registered_optin's dispatch
  // intent feeds the outcome label below. The select tolerates a not-yet-
  // migrated DB: if sms_consent_mode is missing, fall back to the legacy
  // column list and treat the campaign as verbal_yes (today's behavior).
  type SmsCampaignConfig = {
    sms_enabled: boolean | null;
    sms_template: string | null;
    sms_on_goal_reached_only: boolean | null;
    sms_consent_mode?: string | null;
    /** VOZ-132 §8: non-empty → last-resort mode (voicemails re-dial; the one
     *  text goes out after the final failed try via the scheduler sweep).
     *  Optional — the legacy fallback select below omits it (pre-migration). */
    sms_last_resort_template?: string | null;
    /** Brand routing anchor (VOZ-198). The `*` select provides it; the legacy
     *  fallback select omits it → undefined → default brand (Lucky7even). */
    cio_workspace?: string | null;
    /** The run's name. Names the Mobivate batch (2026-09-04) so their per-campaign
     *  click report groups like ours. The `*` select provides it; legacy omits it → no name. */
    name?: string | null;
  };
  let campaign: SmsCampaignConfig | null = null;
  {
    // select * (not an explicit list): naming sms_last_resort_template here
    // would make this select FAIL pre-migration and drop to the legacy
    // fallback, which lacks sms_consent_mode — silently degrading live
    // mode-2 campaigns to verbal_yes semantics for the deploy window. With *
    // a missing column is simply absent (undefined → feature off).
    const sel = await supabaseAdmin
      .from("campaigns_v2")
      .select("*")
      .eq("id", callRow.campaign_id)
      .single();
    if (sel.error) {
      console.warn(
        `[sms-gate] mode-aware campaign select failed (${sel.error.message}) — retrying legacy columns, defaulting to verbal_yes`,
      );
      const legacy = await supabaseAdmin
        .from("campaigns_v2")
        .select("sms_enabled, sms_template, sms_on_goal_reached_only")
        .eq("id", callRow.campaign_id)
        .single();
      campaign = (legacy.data as SmsCampaignConfig | null) ?? null;
    } else {
      campaign = sel.data as SmsCampaignConfig | null;
    }
  }
  const smsMode: SmsConsentMode = resolveSmsConsentMode(campaign?.sms_consent_mode);
  // optin_reached_only trigger (Val 2026-08-07): classify THIS call with the
  // dashboard's own attempt tagger, from the same values persisted to calls_v2
  // above — so dispatch and the SMS card's sub-rows share one classifier and
  // no text can ever land under a bucket the mode refuses (the Early hang-up
  // filter invariant). status "completed": deriveAttemptTag only needs it to
  // clear the isConnected gate, and an end-of-call report is by definition a
  // connected call. declinedContact=false: the contact-level decline outcome is
  // written after dispatch — and this mode texts decliners anyway (literal Val).
  const attemptTag = deriveAttemptTag(
    {
      id: (callRow.id as string | null) ?? null,
      campaign_id: (callRow.campaign_id as string | null) ?? "",
      campaign_number_id: (callRow.campaign_number_id as string | null) ?? null,
      status: "completed",
      goal_reached: goalReached,
      voicemail: voicemailDetected,
      ended_reason: endedReason,
      duration_seconds: durationSeconds,
      transcript: transcript ?? null,
      created_at: (callRow.created_at as string | null) ?? null,
    },
    false,
  );
  const decision = decideSmsDispatch({
    mode: smsMode,
    goalReached,
    nativeSuccess,
    voicemailDetected,
    optedOut,
    attemptTag,
    hasVerbalConsent: transcript ? hasGenuineCustomerConsent(transcript) : false,
    agentAnnouncedSms: transcript ? agentMentionedSms(transcript) : false,
    customerDeclinedSms: transcript ? customerDeclinedSms(transcript) : false,
    humanConversation: transcript ? hasRealConversation(transcript) : false,
    lastResortMode:
      typeof campaign?.sms_last_resort_template === "string" &&
      campaign.sms_last_resort_template.trim().length > 0,
  });
  // Both opt-in modes supersede the legacy sms_on_goal_reached_only flag (the
  // mode IS the policy); verbal_yes keeps the original §6 three-condition check.
  // Expressed as "not verbal_yes" (VOZ-245) so a future opt-in mode inherits this
  // instead of silently failing the configured check and never texting.
  const smsConfigured =
    campaign?.sms_enabled === true &&
    Boolean(campaign?.sms_template) &&
    (smsMode !== "verbal_yes" || campaign?.sms_on_goal_reached_only === true);
  // Drives the sent_sms outcome label as well as dispatch, so it must cover
  // every opt-in mode — otherwise an optin_any_pickup player who WAS texted
  // would still be labelled not_interested (Val's original complaint).
  const registeredDispatchIntent = smsMode !== "verbal_yes" && decision.attempt && smsConfigured;

  // ── Update campaign_numbers_v2 outcome ──
  // Adversarial review C2 (2026-05-08): guard against late Vapi end-of-call
  // stomping a sweeper-resolved state or a fresh retry's in_progress. Only
  // update outcome if the number is still in_progress (the state set by the
  // most recent fireCall and not yet resolved by sweeper / chain-next).
  // Worst case: a late Vapi outcome >5min after call end is silently dropped,
  // which is acceptable — at that latency Vapi is effectively broken anyway,
  // and the sweeper has already given the customer a benefit-of-doubt retry.
  //
  // Voicemail-aware outcome routing (2026-05-11): if the transcript showed a
  // voicemail greeting AND no positive/negative customer signal fired, skip
  // the outcome update entirely. Number stays at outcome='in_progress' and
  // the scheduler cron's stale-in_progress sweeper (shipped as 46ba040)
  // resolves it to pending_retry within ~5min — routing voicemail-hit
  // numbers through the normal retry cycle instead of terminating them as
  // 'not_interested'. Maria's policy: 3 attempts × 90min retry interval.
  //
  // goal/opt-out signals ALWAYS win over voicemail detection. A customer
  // who said "yes send SMS" while their voicemail prompt was still playing
  // (extreme edge case, plus the transcript-fallback override above already
  // suppresses fake goalReached from voicemail-contaminated transcripts)
  // still gets sent_sms and an SMS dispatched.
  //
  // Park-for-retry routing, now a PURE tested function (hangupOutcome.decideOutcomePark,
  // 2026-08-13) that owns all three park classes and their guard semantics verbatim:
  //  - voicemail (2026-05-11): parks regardless of dispatch intent — registered_optin
  //    texts the missed-call followup AND retries the number.
  //  - callback (VOZ-127): a reached human who asked to be called back later would
  //    otherwise fall to the terminal `not_interested` below and be dropped.
  //  - silent_pickup (2026-08-13): the line answered but NOBODY ever spoke. Measured
  //    that day: all 158 dead-air pickups were retired as 'not_interested' — a refusal
  //    by players who never said a word — while detected voicemails correctly rode the
  //    retry cycle. Parks them like voicemails; optin_any_pickup's texted silent
  //    pickups still retire as sent_sms (the registeredDispatchIntent guard).
  const park = decideOutcomePark({
    voicemailDetected,
    goalReached,
    optedOut,
    registeredDispatchIntent,
    callbackRequested: Boolean(transcript) && customerRequestedCallback(transcript),
    attemptTag,
  });

  if (park === "voicemail") {
    console.log(
      `[vapi end-of-call] voicemail detected — skipping outcome update so the ` +
      `scheduler stale-in_progress sweeper resolves to pending_retry. ` +
      `vapiCallId=${vapiCallId}`,
    );
  } else if (park === "callback") {
    console.log(
      `[vapi end-of-call] callback requested (VOZ-127) — skipping outcome update so ` +
      `the scheduler stale-in_progress sweeper resolves to pending_retry (capped by ` +
      `max_attempts). vapiCallId=${vapiCallId}`,
    );
  } else if (park === "silent_pickup") {
    console.log(
      `[vapi end-of-call] silent pickup (zero user turns) — skipping outcome update so ` +
      `the scheduler stale-in_progress sweeper resolves to pending_retry instead of ` +
      `retiring the player as not_interested. vapiCallId=${vapiCallId}`,
    );
  } else {
    // Mode-aware label (2026-06-11): in registered_optin, an announced+configured
    // SMS reads sent_sms — Val's complaint was announced texts landing in
    // "not_interested", which the segment UI defines as "Explicit no overall".
    // verbal_yes mapping unchanged.
    const outcome =
      optedOut ? "declined_offer" : goalReached || registeredDispatchIntent ? "sent_sms" : "not_interested";
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome })
      .eq("id", callRow.campaign_number_id)
      .eq("outcome", "in_progress");
  }

  // ── Auto-suppress on opt-out (Manifesto: suppression checked before every dial) ──
  if (optedOut) {
    const { data: numRow } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .eq("id", callRow.campaign_number_id)
      .single();

    if (numRow?.phone_e164) {
      await supabaseAdmin
        .from("suppression_list")
        .upsert(
          {
            phone_e164: numRow.phone_e164,
            // The reason is the compliance record — "why is this number suppressed" must be
            // answerable months later without re-reading the transcript.
            reason: riskDisclosure ? `risk_disclosure_${riskDisclosure.category}` : "opted_out_on_call",
            added_by: "webhook",
          },
          { onConflict: "phone_e164", ignoreDuplicates: true },
        );
      console.log(
        `Auto-suppressed ${numRow.phone_e164.slice(0, -4)}**** ` +
        `(${riskDisclosure ? `risk disclosure: ${riskDisclosure.category}` : "opted out during call"})`,
      );
    }
  }

  // ── SMS dispatch (Manifesto §6: three conditions must ALL hold) ──
  // (c) Independent compliance gate on the irreversible action (2026-06-04):
  // never dispatch SMS without consent evidence, regardless of how goal_reached
  // was set (covers native-successEvaluation rows too).
  if (!decision.attempt && (goalReached || smsMode !== "verbal_yes")) {
    console.log(`[sms-gate] mode=${smsMode} attempt=false reason=${decision.reason}. vapiCallId=${vapiCallId}`);
  }
  if (decision.attempt && campaign) {
    const smsTemplate = campaign.sms_template;
    const shouldSendSms = smsConfigured && typeof smsTemplate === "string" && smsTemplate.length > 0;

    if (shouldSendSms && typeof smsTemplate === "string") {
      // select * (same rationale as the campaign select above): cio_id feeds the email
      // follow-up event, and naming it explicitly would fail this select in a pre-migration
      // deploy window and kill the SMS with it.
      const { data: numRow } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("*")
        .eq("id", callRow.campaign_number_id)
        .single();

      if (numRow) {
        // Suppression gate: never SMS a number on the suppression list
        const { data: suppressed } = await supabaseAdmin
          .from("suppression_list")
          .select("id")
          .eq("phone_e164", numRow.phone_e164)
          .limit(1);

        if (suppressed && suppressed.length > 0) {
          console.log(`SMS skipped for ${numRow.phone_e164.slice(0, -4)}**** (on suppression list)`);
        } else {
          // Idempotency + per-player dedup (2026-06-11): ONE text per player per
          // campaign. Keyed on campaign_number_id (not call_id) so webhook
          // re-delivery AND retry attempts both dedupe — a 3-retry voicemail
          // player gets exactly one missed-call follow-up, and a human answer
          // after a voicemail follow-up never sends a second copy. Review fixes
          // (2026-06-12): fail CLOSED on a dedup read error (an irreversible
          // send must not ride on a failed check); 'failed' rows never block
          // (a Mobivate error must not permanently burn the player's one text);
          // 'queued' rows block only while FRESH — a crash/hang/unconfigured key
          // strands queued rows forever, and those must not eat the text. Stale
          // queued rows are repaired to 'failed' before the new dispatch.
          // verbal_yes corner: a late Vapi webhook + sweeper re-dial + second
          // consent used to double-text; it now dedupes (fewer duplicates).
          const QUEUED_FRESH_MS = 15 * 60 * 1000;
          const { data: priorSms, error: dedupErr } = await supabaseAdmin
            .from("sms_messages_v2")
            .select("id, status, created_at")
            .eq("campaign_number_id", callRow.campaign_number_id)
            .neq("status", "failed")
            .limit(5);

          if (dedupErr) {
            console.error(
              `[sms-gate] dedup check failed — skipping dispatch (fail-closed). vapiCallId=${vapiCallId}:`,
              dedupErr,
            );
          } else {
            const staleQueued = (priorSms ?? []).filter(
              (s) =>
                s.status === "queued" &&
                Date.now() - Date.parse(s.created_at as string) >= QUEUED_FRESH_MS,
            );
            if (staleQueued.length > 0) {
              await supabaseAdmin
                .from("sms_messages_v2")
                .update({ status: "failed", error_message: "stale queued — superseded by a new dispatch" })
                .in("id", staleQueued.map((s) => s.id));
            }
            const blocking = (priorSms ?? []).filter((s) => !staleQueued.some((q) => q.id === s.id));

            if (blocking.length === 0) {
              const { data: smsRow, error: smsInsertErr } = await supabaseAdmin
                .from("sms_messages_v2")
                .insert({
                  campaign_id: callRow.campaign_id,
                  call_id: callRow.id,
                  campaign_number_id: callRow.campaign_number_id,
                  to_phone_e164: numRow.phone_e164,
                  body: smsTemplate,
                  provider: "mobivate",
                  status: "queued",
                })
                .select("id")
                .single();

              if (smsInsertErr || !smsRow) {
                // With the partial unique index (sms-dedup migration), a raced
                // duplicate insert lands here — never send an untracked SMS.
                console.error(
                  `[sms-gate] sms row insert failed — NOT sending. vapiCallId=${vapiCallId}:`,
                  smsInsertErr,
                );
              } else {
                const { sendSMS, getMobivateConfigError, resolveSmsSenderId } = await import("@/lib/mobivate");

                if (!getMobivateConfigError()) {
                  // Per-brand originator (per-brand SMS): resolve from the campaign's
                  // cio_workspace. Fail closed — an unconfigured brand records the row
                  // 'failed' instead of sending a brand's offer under Lucky7even's name.
                  const { senderId, error: senderErr } = resolveSmsSenderId(campaign?.cio_workspace);
                  if (senderErr || !senderId) {
                    console.error(
                      `[sms-gate] no sender ID for brand '${campaign?.cio_workspace ?? "(default)"}' — NOT sending. ` +
                      `${senderErr}. vapiCallId=${vapiCallId}`,
                    );
                    await supabaseAdmin
                      .from("sms_messages_v2")
                      .update({ status: "failed", error_message: senderErr ?? "sender ID unresolved" })
                      .eq("id", smsRow.id);
                  } else {
                    const result = await sendSMS({
                      to: numRow.phone_e164,
                      body: smsTemplate,
                      reference: smsRow.id,
                      originator: senderId,
                      campaignName: campaign?.name ?? null,
                    });

                    await supabaseAdmin
                      .from("sms_messages_v2")
                      .update({
                        status: result.success ? "sent" : "failed",
                        provider_message_id: result.providerMessageId,
                        error_message: result.error,
                        sender_id: senderId,
                      })
                      .eq("id", smsRow.id);

                    console.log(
                      `SMS ${result.success ? "sent" : "failed"} for ${numRow.phone_e164.slice(0, -4)}**** ` +
                      `(brand=${campaign?.cio_workspace ?? "default"}, sender=${senderId}, reason=${decision.reason}, provider_id=${result.providerMessageId})`,
                    );

                    // ── Email follow-up event (2026-09-01 plan) ──
                    // Fires ONLY here, inside the same block the SMS just cleared: consent
                    // decision, suppression_list, SMS dedup and the risk-disclosure veto all
                    // stand between the call and this line. sms_sent carries the actual SMS
                    // outcome; the event fires either way — it is a CALL follow-up, and the
                    // email is CIO's channel, not a retry of ours. Never throws; its own
                    // ledger's unique index makes webhook retries a no-op. The sweep lane
                    // (lastResortSweep) deliberately does NOT fire this — Q2, narrow start.
                    await fireCallFollowup(supabaseAdmin, {
                      workspace: campaign?.cio_workspace ?? null,
                      campaignId: (callRow.campaign_id as string | null) ?? null,
                      campaignNumberId: callRow.campaign_number_id as string,
                      callId: (callRow.id as string | null) ?? null,
                      phone: numRow.phone_e164 as string,
                      rowCioId: (numRow as { cio_id?: string | null }).cio_id ?? null,
                      callOutcome: attemptTag,
                      smsSent: result.success === true,
                    });
                  }
                } else {
                  console.warn(
                    `SMS queued for ${numRow.phone_e164.slice(0, -4)}**** (reason=${decision.reason}) but ` +
                    `Mobivate not configured — row stays 'queued' until the API key is set.`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  return NextResponse.json({ received: true, matched: true });
}
