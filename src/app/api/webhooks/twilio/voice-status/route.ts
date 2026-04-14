import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { validateTwilioSignature } from "@/lib/twilioClient";
import { findNextNumber, fireCall, isWithinCallWindow } from "@/lib/dialer";

/**
 * POST /api/webhooks/twilio/voice-status
 *
 * Twilio calls this on every call status change (initiated, ringing, answered, completed).
 * Query params: callId, campaignId, numberId
 *
 * Manifesto §6 compliance:
 * - Twilio signature validated on every request
 * - Idempotent: uses provider_call_id + status as idempotency key
 * - Call window checked before every chain-dial
 * - Suppression checked before every dial (inside findNextNumber)
 */
export async function POST(request: NextRequest) {
  // ── Signature validation (Manifesto §6: no exceptions) ──
  const signature = request.headers.get("x-twilio-signature") || "";
  const url = request.url;
  const formData = await request.formData();
  const params: Record<string, string> = {};
  formData.forEach((value, key) => { params[key] = String(value); });

  if (!validateTwilioSignature(url, params, signature)) {
    console.warn("Twilio webhook: invalid signature — rejecting");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  // ── Parse params ──
  const { searchParams } = new URL(request.url);
  const callId = searchParams.get("callId");
  const campaignId = searchParams.get("campaignId");
  const numberId = searchParams.get("numberId");

  if (!callId || !campaignId || !numberId) {
    return NextResponse.json({ error: "Missing query params" }, { status: 400 });
  }

  const callStatus = params["CallStatus"] || "";
  const callDuration = params["CallDuration"] || null;
  const twilioCallSid = params["CallSid"] || null;

  // ── Idempotency check (Manifesto §6: tolerate duplicate webhooks) ──
  if (twilioCallSid) {
    const { data: existingCall } = await supabaseAdmin
      .from("calls_v2")
      .select("status")
      .eq("id", callId)
      .single();

    // If we already processed this terminal status, skip
    const terminalStatuses = ["completed", "busy", "no_answer", "failed", "canceled"];
    if (existingCall && terminalStatuses.includes(existingCall.status)) {
      return NextResponse.json({ received: true, idempotent: "already processed" });
    }
  }

  // ── Map Twilio status to our status ──
  const statusMap: Record<string, string> = {
    initiated: "initiated",
    ringing: "ringing",
    "in-progress": "in_progress",
    completed: "completed",
    busy: "busy",
    "no-answer": "no_answer",
    failed: "failed",
    canceled: "canceled",
  };
  const mappedStatus = statusMap[callStatus] || callStatus;

  // ── Update calls_v2 ──
  const updatePayload: Record<string, unknown> = {
    status: mappedStatus,
  };
  if (twilioCallSid) updatePayload.provider_call_id = twilioCallSid;
  if (callStatus === "in-progress") updatePayload.answered_at = new Date().toISOString();
  if (callStatus === "completed") {
    updatePayload.ended_at = new Date().toISOString();
    if (callDuration) updatePayload.duration_seconds = parseInt(callDuration, 10);
  }

  await supabaseAdmin.from("calls_v2").update(updatePayload).eq("id", callId);

  // ── Only chain on terminal statuses ──
  const terminalStatuses = ["completed", "busy", "no-answer", "failed", "canceled"];
  if (!terminalStatuses.includes(callStatus)) {
    return NextResponse.json({ received: true });
  }

  // ── Update campaign_numbers_v2 ──
  const { data: numRow } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("attempt_count, outcome")
    .eq("id", numberId)
    .single();

  const newAttemptCount = (numRow?.attempt_count ?? 0) + 1;

  // Get campaign for retry config
  const { data: campaign } = await supabaseAdmin
    .from("campaigns_v2")
    .select("max_attempts, retry_interval_minutes, status, vapi_assistant_id, call_windows, timezone")
    .eq("id", campaignId)
    .single();

  // ── Determine outcome (H4 fix: don't overwrite Vapi-set outcomes) ──
  const vapiSetOutcomes = ["sent_sms", "not_interested", "declined_offer"];
  if (numRow && vapiSetOutcomes.includes(numRow.outcome)) {
    // Vapi already set the final outcome — just update attempt count, don't overwrite
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
      })
      .eq("id", numberId);
  } else if (callStatus === "completed") {
    // Call connected but Vapi hasn't reported yet — leave as in_progress
    // Vapi end-of-call webhook will set the final outcome
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
      })
      .eq("id", numberId);
  } else if (newAttemptCount >= (campaign?.max_attempts ?? 3)) {
    // Exhausted retries on a non-completed status
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
        outcome: "unreached",
      })
      .eq("id", numberId);
  } else {
    // Schedule retry (busy, no-answer, failed with retries remaining)
    const retryMinutes = campaign?.retry_interval_minutes ?? 90;
    const nextAttempt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
        next_attempt_at: nextAttempt,
        outcome: "pending_retry",
      })
      .eq("id", numberId);
  }

  // ── Chain to next call ──
  return await chainNextCall(campaignId, campaign, request);
}

async function chainNextCall(
  campaignId: string,
  campaign: Record<string, unknown> | null,
  request: NextRequest,
) {
  if (!campaign || campaign.status !== "running") {
    return NextResponse.json({ received: true, next: "campaign not running" });
  }

  // ── Call window check (Manifesto §6: check before EVERY dial) ──
  const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
  const timezone = campaign.timezone as string | null;
  if (callWindows && timezone && !isWithinCallWindow(callWindows, timezone)) {
    // Outside call window — pause campaign, don't dial
    await supabaseAdmin
      .from("campaigns_v2")
      .update({ status: "paused" })
      .eq("id", campaignId);
    return NextResponse.json({ received: true, next: "outside call window — paused" });
  }

  const nextNumber = await findNextNumber(campaignId);
  if (!nextNumber) {
    await supabaseAdmin
      .from("campaigns_v2")
      .update({ status: "completed" })
      .eq("id", campaignId);
    return NextResponse.json({ received: true, next: "campaign completed" });
  }

  const baseUrl = getBaseUrl(request);
  try {
    await fireCall(campaignId, nextNumber, campaign.vapi_assistant_id as string, baseUrl);
    return NextResponse.json({ received: true, next: nextNumber.phone_e164 });
  } catch (err) {
    console.error("Failed to chain next call:", err);
    return NextResponse.json({ received: true, next: "chain failed" });
  }
}

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}
