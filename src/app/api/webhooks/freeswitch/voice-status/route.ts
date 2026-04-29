/**
 * POST /api/webhooks/freeswitch/voice-status
 *
 * Receives CHANNEL_HANGUP_COMPLETE events from the FreeSWITCH webhook-shim
 * (infra/freeswitch/webhook-shim/) running on the EC2 box alongside FS.
 *
 * The shim only emits terminal (hangup) events — unlike Twilio which sends
 * initiated/ringing/answered/completed. So this handler treats every event
 * as terminal: update calls_v2, update campaign_numbers_v2, chain next call.
 *
 * Manifesto §6 compliance:
 * - HMAC-SHA256 signature validated on every request
 * - Idempotent: re-processing the same voizo_call_id is a no-op on terminal status
 * - Call window checked before every chain-dial
 * - Suppression checked before every dial (inside findNextNumber)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { validateFreeSwitchSignature } from "@/lib/freeswitch/validateWebhook";
import { findNextNumber, fireCall, isWithinCallWindow } from "@/lib/dialer";

// Chain-next dial in this handler calls the originate-shim, which blocks 8-22s
// on FS bgapi (memory project_freeswitch_bgapi_slow). Default Vercel timeout
// would 504 before bgapi returns; bumping to 60s matches the shim's own ceiling.
export const maxDuration = 60;

interface ShimPayload {
  voizo_call_id: string | null;
  voizo_campaign_id: string | null;
  voizo_number_id: string | null;
  call_uuid: string | null;
  event_name: string | null;
  hangup_cause: string | null;
  duration: string | null;
  timestamp: string | null;
}

/**
 * Map FreeSWITCH hangup causes to our internal call status + terminal outcome.
 * Reference: https://freeswitch.org/confluence/display/FREESWITCH/Hangup+Cause+Code+Table
 *
 * `duration` is used to disambiguate NORMAL_CLEARING after a real connect (completed)
 * from NORMAL_CLEARING on an unanswered leg (spam-filtered 480s often surface this way).
 */
function mapHangup(
  hangupCause: string | null,
  duration: number,
): { status: string; terminalOutcome: "completed" | "busy" | "no_answer" | "failed" | "canceled" } {
  const cause = (hangupCause || "").toUpperCase();

  if (cause === "NORMAL_CLEARING" && duration > 0) {
    return { status: "completed", terminalOutcome: "completed" };
  }
  if (cause === "USER_BUSY") return { status: "busy", terminalOutcome: "busy" };
  if (cause === "NO_ANSWER" || cause === "ALLOTTED_TIMEOUT") {
    return { status: "no_answer", terminalOutcome: "no_answer" };
  }
  if (cause === "ORIGINATOR_CANCEL") return { status: "canceled", terminalOutcome: "canceled" };

  // NORMAL_CLEARING with 0 duration = carrier dropped before real answer
  if (cause === "NORMAL_CLEARING" && duration === 0) {
    return { status: "no_answer", terminalOutcome: "no_answer" };
  }

  return { status: "failed", terminalOutcome: "failed" };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-freeswitch-signature");

  if (!validateFreeSwitchSignature(rawBody, signature)) {
    console.warn("[freeswitch.voice-status] invalid signature — rejecting");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  let payload: ShimPayload;
  try {
    payload = JSON.parse(rawBody) as ShimPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const callId = payload.voizo_call_id;
  const campaignId = payload.voizo_campaign_id;
  const numberId = payload.voizo_number_id;

  if (!callId || !campaignId || !numberId) {
    // Shim already filters these out, but belt-and-braces
    return NextResponse.json({ error: "Missing voizo_* identifiers" }, { status: 400 });
  }

  const duration = payload.duration ? parseInt(payload.duration, 10) || 0 : 0;
  const { status, terminalOutcome } = mapHangup(payload.hangup_cause, duration);

  const updatePayload: Record<string, unknown> = {
    status,
    ended_at: new Date().toISOString(),
    duration_seconds: duration,
  };
  if (payload.call_uuid) updatePayload.provider_call_id = payload.call_uuid;

  // Atomic idempotency claim. We try to flip calls_v2 from a non-terminal
  // state to the new terminal state in a single UPDATE filtered by status.
  // If another invocation got there first (or the row doesn't exist), the
  // RETURNING set is empty and we skip the rest of the handler.
  //
  // This replaces a SELECT-then-UPDATE pattern that had a TOCTOU window:
  // two near-simultaneous deliveries of the same hangup event could both
  // pass the idempotency check before either UPDATE landed, then both fire
  // chain-next — double-dialing the next number.
  const TERMINAL_STATUSES = ["completed", "busy", "no_answer", "failed", "canceled"];
  const { data: claimedRows, error: claimErr } = await supabaseAdmin
    .from("calls_v2")
    .update(updatePayload)
    .eq("id", callId)
    .not("status", "in", `(${TERMINAL_STATUSES.join(",")})`)
    .select("id");

  if (claimErr) {
    console.error("[freeswitch.voice-status] claim error:", claimErr);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!claimedRows || claimedRows.length === 0) {
    // Row already terminal (idempotent retry) or unknown callId. Either way,
    // a no-op for us. Returning 200 prevents shim retry storms.
    return NextResponse.json({ received: true, idempotent: "already processed" });
  }

  // Update campaign_numbers_v2 — mirrors the Twilio handler's outcome logic
  const { data: numRow } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("attempt_count, outcome")
    .eq("id", numberId)
    .single();

  const newAttemptCount = (numRow?.attempt_count ?? 0) + 1;

  const { data: campaign } = await supabaseAdmin
    .from("campaigns_v2")
    .select("max_attempts, retry_interval_minutes, status, vapi_assistant_id, vapi_sip_uri, call_windows, timezone")
    .eq("id", campaignId)
    .single();

  // Don't overwrite Vapi-set outcomes (sent_sms, not_interested, declined_offer)
  const vapiSetOutcomes = ["sent_sms", "not_interested", "declined_offer"];
  if (numRow && vapiSetOutcomes.includes(numRow.outcome)) {
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
      })
      .eq("id", numberId);
  } else if (terminalOutcome === "completed") {
    // Vapi's end-of-call webhook will set the final outcome
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
      })
      .eq("id", numberId);
  } else if (newAttemptCount >= (campaign?.max_attempts ?? 3)) {
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({
        attempt_count: newAttemptCount,
        last_attempted_at: new Date().toISOString(),
        outcome: "unreached",
      })
      .eq("id", numberId);
  } else {
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

  // Chain next call
  if (!campaign || campaign.status !== "running") {
    return NextResponse.json({ received: true, next: "campaign not running" });
  }

  const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
  const timezone = campaign.timezone as string | null;
  if (callWindows && timezone && !isWithinCallWindow(callWindows, timezone)) {
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

  const host = request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const baseUrl = `${proto}://${host}`;

  try {
    await fireCall(campaignId, nextNumber, campaign.vapi_assistant_id as string, baseUrl, (campaign.vapi_sip_uri as string) ?? undefined);
    return NextResponse.json({ received: true, next: nextNumber.phone_e164 });
  } catch (err) {
    console.error("[freeswitch.voice-status] chain-next failed:", err);
    return NextResponse.json({ received: true, next: "chain failed" });
  }
}
