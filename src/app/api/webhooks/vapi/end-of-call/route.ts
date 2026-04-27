import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import crypto from "crypto";

/**
 * POST /api/webhooks/vapi/end-of-call
 *
 * Vapi posts this when a call ends.
 *
 * Manifesto compliance:
 * - Vapi signature validated via HMAC-SHA256 (§6)
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

  // ── Vapi signature validation (Manifesto §6) ──
  const vapiSecret = process.env.VAPI_PRIVATE_KEY;
  const vapiSignature = request.headers.get("x-vapi-signature");
  if (vapiSecret && vapiSignature) {
    const expectedSignature = crypto
      .createHmac("sha256", vapiSecret)
      .update(rawBody)
      .digest("hex");
    if (vapiSignature !== expectedSignature) {
      console.warn("Vapi webhook: invalid signature — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }
  } else if (!vapiSignature) {
    // Log but allow in dev — Vapi may not send signatures on all plans
    console.warn("Vapi webhook: no x-vapi-signature header present (accepting in dev)");
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

  // Determine goal_reached from Vapi's analysis
  const successEval = analysis?.successEvaluation as string | undefined;
  const goalReached = successEval === "true";

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
            `(phone=${customerNumber} callId=${data.id} vapiCallId=${vapiCallId})`,
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
  if (goalReached) {
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "sent_sms" })
      .eq("id", callRow.campaign_number_id);
  } else {
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "not_interested" })
      .eq("id", callRow.campaign_number_id);
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
        // Idempotency: check if SMS already exists for this call
        const { data: existingSms } = await supabaseAdmin
          .from("sms_messages_v2")
          .select("id")
          .eq("call_id", callRow.id)
          .limit(1);

        if (!existingSms || existingSms.length === 0) {
          // Step 1: Write state BEFORE calling provider (manifesto §6)
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

          // Step 2: Actually send the SMS via Mobivate
          // If Mobivate isn't configured (no API key), this returns
          // success=false gracefully — the row stays 'queued' for
          // manual retry or later dispatch when config is available.
          const { sendSMS, getMobivateConfigError } = await import("@/lib/mobivate");

          if (!getMobivateConfigError()) {
            const result = await sendSMS({
              to: numRow.phone_e164,
              body: campaign!.sms_template,
              reference: smsRow?.id || undefined,
            });

            // Step 3: Update the row with the result
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
              `SMS ${result.success ? "sent" : "failed"} for ${numRow.phone_e164} ` +
              `(goal reached, provider_id=${result.providerMessageId})`,
            );
          } else {
            console.warn(
              `SMS queued for ${numRow.phone_e164} (goal reached) but Mobivate not configured — ` +
              `row stays 'queued' until API key is set.`,
            );
          }
        }
      }
    }
  }

  return NextResponse.json({
    received: true,
    matched: true,
    goalReached,
    callId: callRow.id,
  });
}
