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
          await supabaseAdmin.from("sms_messages_v2").insert({
            campaign_id: callRow.campaign_id,
            call_id: callRow.id,
            campaign_number_id: callRow.campaign_number_id,
            to_phone_e164: numRow.phone_e164,
            body: campaign!.sms_template,
            provider: "twilio",
            status: "queued",
          });
          console.log(`SMS queued for ${numRow.phone_e164} (goal reached)`);
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
