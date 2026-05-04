import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import crypto from "crypto";

/**
 * POST /api/webhooks/vapi/end-of-call
 *
 * Vapi posts this when a call ends.
 *
 * Manifesto compliance:
 * - Vapi webhook authenticated via x-vapi-secret token (§6 — per Vapi's documented method)
 * - Idempotent: checks if goal_reached already set on this call (§6)
 * - SMS fires only when goal_reached=true AND sms_enabled=true AND sms_on_goal_reached_only=true (§6: 3 conditions)
 * - Call matching uses Vapi's phoneCallProviderId (Twilio SID) — no fragile fallback
 */
export async function POST(request: NextRequest) {
  // ── Read raw body for signature validation ──
  const rawBody = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Vapi webhook authentication (Manifesto §6) ──
  // Vapi's server.secret sends the raw token as the x-vapi-secret header.
  // We validate with constant-time comparison. VAPI_WEBHOOK_SECRET is the
  // dedicated secret (preferred); falls back to VAPI_PRIVATE_KEY for compat.
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET || process.env.VAPI_PRIVATE_KEY;
  const vapiSecretHeader = request.headers.get("x-vapi-secret");
  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error("FATAL: VAPI_WEBHOOK_SECRET not set — rejecting webhook");
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }
    console.warn("Vapi webhook: no webhook secret configured (accepting in dev only)");
  } else if (!vapiSecretHeader) {
    console.warn("Vapi webhook: missing x-vapi-secret header — rejecting");
    return NextResponse.json({ error: "Missing signature" }, { status: 403 });
  } else {
    // Constant-time comparison to prevent timing attacks
    const received = Buffer.from(vapiSecretHeader, "utf-8");
    const expected = Buffer.from(webhookSecret, "utf-8");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      console.warn("Vapi webhook: invalid x-vapi-secret — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }
  }

  // ── Parse Vapi payload ──
  const message = body.message as Record<string, unknown> | undefined;
  if (!message || message.type !== "end-of-call-report") {
    return NextResponse.json({ received: true });
  }

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
  const artifact = vapiCall?.artifact as Record<string, unknown> | undefined;
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

  // Determine goal_reached from Vapi's analysis.
  // Vapi's successEvaluation can be string | boolean | number | null depending
  // on API version (June 2025 breaking change). Handle all variants defensively.
  const successEval = analysis?.successEvaluation;
  let goalReached = successEval === true || successEval === "true";
  let goalSource: "vapi" | "fallback" = "vapi";

  // ── Fallback: transcript-based success evaluation ──
  // As of 2026-05-04, Vapi's post-call analysis never runs on our SIP inbound
  // calls (51/51 returned analysis:{}). Until Vapi resolves this, we evaluate
  // the transcript ourselves when their analysis is missing.
  //
  // Strategy: Tom's prompt only confirms SMS dispatch ("I'll send you an SMS")
  // AFTER the customer agrees. That AI confirmation line is a reliable downstream
  // signal of customer consent. We scan AI lines for it.
  //
  // Vapi's analysis takes priority when present — this fallback is a safety net.
  if (successEval == null && transcript && !goalReached) {
    // Match AI confirmation of SMS/text dispatch.
    //
    // Pattern 1 (explicit): AI names the channel directly.
    //   "I'll send you an SMS"  /  "I'll send the SMS now"  /  "I'll send you a text"
    //
    // Pattern 2 (contextual): AI uses generic send phrasing ("I'll send that over")
    //   but SMS/text was discussed earlier in the conversation. Both parts must hold
    //   to avoid false positives.
    //   Real example (Maria 2026-05-04):
    //     AI: "Can I send you the details via SMS?"  →  Customer: "Go ahead."
    //     AI: "I'll send that over now."
    const aiExplicit =
      /i(?:'ll| will) send (?:you |the )?(?:an? )?(?:sms|text)/i.test(transcript);
    const smsDiscussed = /\bsms\b|text message/i.test(transcript);
    const aiConfirmedSend = /i(?:'ll| will) send (?:that|it)\b/i.test(transcript);
    const aiConfirmedSms = aiExplicit || (smsDiscussed && aiConfirmedSend);

    if (aiConfirmedSms) {
      goalReached = true;
      goalSource = "fallback";
      console.log(
        `[fallback-eval] goal_reached=true via transcript pattern ` +
        `(Vapi analysis missing, AI confirmed SMS dispatch). vapiCallId=${vapiCallId}`,
      );
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
  if (successEval == null && transcript && !optedOut) {
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

  // ── Match to our calls_v2 record (H1 fix: reliable matching) ──
  // Strategy: match by vapi_call_id first, then by phoneCallProviderId (Twilio SID)
  let callRow: Record<string, unknown> | null = null;

  // 1. Try vapi_call_id (if we already stored it)
  if (vapiCallId) {
    const { data } = await supabaseAdmin
      .from("calls_v2")
      .select("*")
      .eq("vapi_call_id", vapiCallId)
      .single();
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
        .single();
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
  }

  if (!callRow) {
    console.warn("Vapi end-of-call: no matching call record found", { vapiCallId });
    return NextResponse.json({ received: true, matched: false });
  }

  // ── Idempotency check (C4 fix: don't process same call twice) ──
  if (callRow.goal_reached !== null) {
    return NextResponse.json({ received: true, idempotent: "already processed" });
  }

  // ── Update calls_v2 with transcript and goal_reached ──
  await supabaseAdmin
    .from("calls_v2")
    .update({
      vapi_call_id: vapiCallId || null,
      transcript: transcript ? { text: transcript } : null,
      goal_reached: goalReached,
    })
    .eq("id", callRow.id);

  // ── Update campaign_numbers_v2 outcome ──
  const outcome = optedOut ? "declined_offer" : goalReached ? "sent_sms" : "not_interested";
  await supabaseAdmin
    .from("campaign_numbers_v2")
    .update({ outcome })
    .eq("id", callRow.campaign_number_id);

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
          { phone_e164: numRow.phone_e164, reason: "opted_out_on_call", added_by: "webhook" },
          { onConflict: "phone_e164", ignoreDuplicates: true },
        );
      console.log(`Auto-suppressed ${numRow.phone_e164.slice(0, -4)}**** (opted out during call)`);
    }
  }

  // ── SMS dispatch (Manifesto §6: three conditions must ALL hold) ──
  if (goalReached) {
    const { data: campaign } = await supabaseAdmin
      .from("campaigns_v2")
      .select("sms_enabled, sms_template, sms_on_goal_reached_only")
      .eq("id", callRow.campaign_id)
      .single();

    const shouldSendSms =
      campaign?.sms_enabled === true &&
      campaign?.sms_on_goal_reached_only === true &&
      Boolean(campaign?.sms_template);

    if (shouldSendSms) {
      const { data: numRow } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("phone_e164")
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
          // Idempotency: check if SMS already exists for this call
          const { data: existingSms } = await supabaseAdmin
            .from("sms_messages_v2")
            .select("id")
            .eq("call_id", callRow.id)
            .limit(1);

          if (!existingSms || existingSms.length === 0) {
            const { data: smsRow } = await supabaseAdmin
              .from("sms_messages_v2")
              .insert({
                campaign_id: callRow.campaign_id,
                call_id: callRow.id,
                campaign_number_id: callRow.campaign_number_id,
                to_phone_e164: numRow.phone_e164,
                body: campaign!.sms_template,
                provider: "mobivate",
                status: "queued",
              })
              .select("id")
              .single();

            const { sendSMS, getMobivateConfigError } = await import("@/lib/mobivate");

            if (!getMobivateConfigError()) {
              const result = await sendSMS({
                to: numRow.phone_e164,
                body: campaign!.sms_template,
                reference: smsRow?.id || undefined,
              });

              if (smsRow) {
                await supabaseAdmin
                  .from("sms_messages_v2")
                  .update({
                    status: result.success ? "sent" : "failed",
                    provider_message_id: result.providerMessageId,
                    error_message: result.error,
                  })
                  .eq("id", smsRow.id);
              }

              console.log(
                `SMS ${result.success ? "sent" : "failed"} for ${numRow.phone_e164.slice(0, -4)}**** ` +
                `(goal reached, provider_id=${result.providerMessageId})`,
              );
            } else {
              console.warn(
                `SMS queued for ${numRow.phone_e164.slice(0, -4)}**** (goal reached) but Mobivate not configured — ` +
                `row stays 'queued' until API key is set.`,
              );
            }
          }
        }
      }
    }
  }

  return NextResponse.json({ received: true, matched: true });
}
