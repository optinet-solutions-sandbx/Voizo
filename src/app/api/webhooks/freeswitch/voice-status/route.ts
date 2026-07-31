/**
 * POST /api/webhooks/freeswitch/voice-status
 *
 * Receives CHANNEL_HANGUP_COMPLETE events from the FreeSWITCH webhook-shim
 * (infra/freeswitch/webhook-shim/) running on the EC2 box alongside FS.
 *
 * The shim only emits terminal (hangup) events, not per-status
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
import { findNextNumber, fireCall, hasPendingRetry, isWithinCallWindow } from "@/lib/dialer";
import { shouldStayAwakeRealtime } from "@/lib/scheduleWindow";
import { completedNumberOutcomeOverride, mapHangup, resolveAttemptCount } from "@/lib/webhooks/hangupOutcome";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { pauseReleasesSlot } from "@/lib/featureFlags";

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
  /** FreeSWITCH `duration`: TOTAL channel seconds INCLUDING ring. Kept for the
   *  legacy path — do NOT treat a non-zero value as evidence of a conversation. */
  duration: string | null;
  /** VOZ-247: FreeSWITCH `billsec` — answer→hangup seconds, "0" when never
   *  answered. Absent until the EC2 shim is redeployed. */
  talk_seconds?: string | null;
  /** VOZ-247: FreeSWITCH `answer_stamp` — present only on an answered channel. */
  answer_stamp?: string | null;
  timestamp: string | null;
}

// mapHangup moved to @/lib/webhooks/hangupOutcome (VOZ-247) so the rule that
// decides how EVERY call is counted is unit-tested rather than inline here.
// It now keys "was this a conversation?" off billsec / answer_stamp instead of
// total channel time — `duration` includes RING, so a phone that rang 25s
// unanswered used to be logged as a 25-second completed call (450 such rows in
// the 07-27/28 run alone). Falls back to the old duration>0 rule when the shim
// has not been redeployed yet, so the two deploys are order-independent.

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

  // parseInt("0") is 0 which is falsy, so `|| 0` is safe here; but a MISSING
  // talk_seconds must stay null (legacy shim) rather than collapse to 0, or
  // every call would read as unanswered during the deploy window.
  const totalSeconds = payload.duration ? parseInt(payload.duration, 10) || 0 : 0;
  const talkSeconds =
    typeof payload.talk_seconds === "string" && payload.talk_seconds.trim() !== ""
      ? parseInt(payload.talk_seconds, 10) || 0
      : null;
  const { status, terminalOutcome, durationSeconds, answered } = mapHangup(payload.hangup_cause, {
    totalSeconds,
    talkSeconds,
    answerStamp: payload.answer_stamp ?? null,
  });
  const updatePayload: Record<string, unknown> = {
    status,
    ended_at: new Date().toISOString(),
    // TALK time once the shim reports it — never the ring window (VOZ-247).
    duration_seconds: durationSeconds,
    // Persist the RAW FreeSWITCH hangup cause (carrier/outbound-leg "why") alongside the coarse
    // `status`. mapHangup() still derives status from it; this keeps the granular cause for
    // failure-mix observability (was discarded before). See call-observability migration.
    hangup_cause: payload.hangup_cause,
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

  // ── Ghost-call recovery (VOZ-248) ──────────────────────────────────────────
  // A shim/ESL timeout makes fireCall's catch mark the row 'failed' (dialer.ts)
  // even though bgapi is BACKGROUND and FreeSWITCH went on to place the call.
  // 'failed' is terminal, so the claim above missed and the REAL outcome used to
  // be discarded: status stuck 'failed', duration NULL, and — worst — chain-next
  // never ran, so the campaign sat idle until the scheduler's resume sweep.
  // Measured 2026-07-27/28: 27 of 251 calls that actually reached Vapi (10.8%).
  //
  // A hangup event ARRIVING for a failed row with NO hangup_cause is itself
  // proof the call was real — a genuinely-failed originate never produces one.
  // So this second claim is self-identifying and cannot touch a real failure.
  // Kept as a SEPARATE atomic UPDATE rather than widening the filter above:
  // whichever claim wins tells us unambiguously whether this was a ghost, with
  // no extra read and no race (both are single filtered UPDATEs, so exactly one
  // concurrent invocation can win either).
  let wasGhost = false;
  let claimed = claimedRows;
  if (!claimed || claimed.length === 0) {
    const { data: ghostRows, error: ghostErr } = await supabaseAdmin
      .from("calls_v2")
      .update(updatePayload)
      .eq("id", callId)
      .eq("status", "failed")
      .is("hangup_cause", null)
      .select("id");
    if (ghostErr) {
      console.error("[freeswitch.voice-status] ghost claim error:", ghostErr);
      return NextResponse.json({ error: "DB error" }, { status: 500 });
    }
    if (ghostRows && ghostRows.length > 0) {
      claimed = ghostRows;
      wasGhost = true;
      console.warn(
        `[freeswitch.voice-status] GHOST RECOVERED (VOZ-248): call=${callId} was marked ` +
          `'failed' by a shim timeout but really connected — corrected to status=${status}, ` +
          `duration=${durationSeconds}s. attempt_count left as-is (fireCall already counted it).`,
      );
    }
  }

  if (!claimed || claimed.length === 0) {
    // Row already terminal (idempotent retry) or unknown callId. Either way,
    // a no-op for us. Returning 200 prevents shim retry storms.
    return NextResponse.json({ received: true, idempotent: "already processed" });
  }

  // Log AFTER the claim (code-review finding, 2026-07-28): shim retries and
  // duplicate ESL deliveries otherwise emit duplicate classification lines,
  // which overcounts in log-based reconciliation. One line per claimed call.
  console.log(
    `[freeswitch.voice-status] cause=${payload.hangup_cause} total=${totalSeconds}s ` +
      `talk=${talkSeconds === null ? "n/a(legacy shim)" : `${talkSeconds}s`} ` +
      `answered=${answered === null ? "unknown" : answered} -> status=${status} call=${callId}`,
  );

  // Update campaign_numbers_v2 — apply terminal outcome logic
  const { data: numRow } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("attempt_count, outcome")
    .eq("id", numberId)
    .single();

  // Ghost rows (VOZ-248) must NOT be counted twice: fireCall's catch already
  // incremented attempt_count and stamped last_attempted_at before this handler
  // ever saw the call. Without this, a recovered ghost would burn 2 of the
  // player's 3 attempts for a single dial and retire them a call early.
  const newAttemptCount = resolveAttemptCount({ current: numRow?.attempt_count ?? null, wasGhost });

  const { data: campaign } = await supabaseAdmin
    .from("campaigns_v2")
    .select("name, max_attempts, retry_interval_minutes, status, vapi_assistant_id, vapi_pool_slot_id, vapi_sip_uri, call_windows, timezone, realtime, end_at")
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
    // Vapi's end-of-call webhook will set the final outcome.
    //
    // VOZ-269: a GHOST recovered to completed still carries the stale
    // pending_retry / unreached that fireCall's catch wrote before this webhook
    // ran (the ESL-timeout marked the row failed AND queued the number, then the
    // ghost claim above corrected only the CALL row). Clear it so the reached
    // player is not re-dialled — 35 of 55 confirmed false-negatives WERE. Scoped
    // to pending_retry / unreached, which a completed call can only be in via that
    // ghost path (fireCall sets the number 'in_progress' before dialing), so this
    // never touches a Vapi-set outcome and is a no-op for a normal completed call.
    const staleOverride = completedNumberOutcomeOverride(numRow?.outcome ?? null);
    const completedNumUpdate: Record<string, unknown> = {
      attempt_count: newAttemptCount,
      last_attempted_at: new Date().toISOString(),
    };
    if (staleOverride) {
      completedNumUpdate.outcome = staleOverride;
      completedNumUpdate.next_attempt_at = null;
    }
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update(completedNumUpdate)
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
    // When PAUSE_RELEASES_SLOT is on (Phase 1+), clear Vapi pointers + run
    // the shared cleanup helper. Flag off → today's behavior preserved.
    //
    // Also adds the .eq("status", "running") guard that was missing on the
    // pre-existing UPDATE (design doc §1.3.c) — minor race fix free with
    // this slice.
    const releaseOnPause = pauseReleasesSlot();
    const capturedAssistantId = campaign.vapi_assistant_id as string | null;
    const capturedSlotId = campaign.vapi_pool_slot_id as string | null;
    const campaignName = campaign.name as string;

    const updatePayload: Record<string, unknown> = { status: "paused" };
    if (releaseOnPause) {
      updatePayload.vapi_assistant_id = null;
      updatePayload.vapi_pool_slot_id = null;
      updatePayload.vapi_sip_uri = null;
      updatePayload.last_paused_at = new Date().toISOString();
    }

    const { data: pausedUpdate } = await supabaseAdmin
      .from("campaigns_v2")
      .update(updatePayload)
      .eq("id", campaignId)
      .eq("status", "running")
      .select("id")
      .single();

    if (pausedUpdate && releaseOnPause) {
      await performCampaignVapiCleanup(supabaseAdmin, {
        vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
        campaignName,
        vapiAssistantId: capturedAssistantId,
        vapiPoolSlotId: capturedSlotId,
      });
    }
    return NextResponse.json({ received: true, next: "outside call window — paused" });
  }

  // Ghost-only in-flight guard (VOZ-248). Normal chain-next needs no such check:
  // it runs the instant a call ends, so nothing else can be dialling. A RECOVERED
  // ghost is different — its hangup event can land a minute or more late, and
  // because the row read 'failed' (not in-flight) the scheduler's resume sweep
  // will already have started the NEXT call. Chaining here would then put two
  // concurrent calls on a campaign that owns exactly ONE SIP slot and clone.
  // The in-flight call's own chain-next continues the loop, so skipping is safe.
  // Scoped to wasGhost so the normal path stays byte-identical.
  if (wasGhost) {
    const { count: inFlight } = await supabaseAdmin
      .from("calls_v2")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", ["initiated", "ringing", "in_progress", "answered"]);
    if (inFlight && inFlight > 0) {
      console.log(
        `[freeswitch.voice-status] ghost recovered but ${inFlight} call(s) already in flight ` +
          `for campaign=${campaignId} — skipping chain-next (the live call will continue it).`,
      );
      return NextResponse.json({ received: true, ghostRecovered: true, next: "in flight elsewhere" });
    }
  }

  const nextNumber = await findNextNumber(campaignId);
  if (!nextNumber) {
    // Keep-awake (VOZ-183): a realtime child with nothing to dial is its
    // NORMAL resting state — the poll/webhook lanes top it up all day. This
    // exact path completed the 07-22 trial child 31s after its only call
    // ended, deafening the campaign for the rest of its window. Same guard
    // as the scheduler's two sweeps (shared predicate, no more drift).
    if (shouldStayAwakeRealtime(campaign, Date.now())) {
      return NextResponse.json({ received: true, next: "idle — realtime child awake until end_at" });
    }
    // No number eligible right now. If retries are queued for the future,
    // stay `running` — the scheduler cron's resume sweep will fire them when
    // their windows arrive. Only mark `completed` when truly nothing remains.
    if (await hasPendingRetry(campaignId)) {
      return NextResponse.json({ received: true, next: "idle — waiting for retry window" });
    }
    // Mirror the outside-window pause block above: when PAUSE_RELEASES_SLOT
    // is on, capture Vapi pointers, clear them in the same UPDATE, and run
    // the shared cleanup helper. Same flag intentionally controls both pause
    // and complete eject (single operator knob, shared semantics).
    const releaseOnComplete = pauseReleasesSlot();
    const capturedAssistantId = campaign.vapi_assistant_id as string | null;
    const capturedSlotId = campaign.vapi_pool_slot_id as string | null;
    const campaignName = campaign.name as string;

    const completePayload: Record<string, unknown> = { status: "completed" };
    if (releaseOnComplete) {
      completePayload.vapi_assistant_id = null;
      completePayload.vapi_pool_slot_id = null;
      completePayload.vapi_sip_uri = null;
    }

    const { data: completedUpdate } = await supabaseAdmin
      .from("campaigns_v2")
      .update(completePayload)
      .eq("id", campaignId)
      .eq("status", "running")
      .select("id")
      .single();

    if (completedUpdate && releaseOnComplete) {
      const { vapiWarnings } = await performCampaignVapiCleanup(supabaseAdmin, {
        vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
        campaignName,
        vapiAssistantId: capturedAssistantId,
        vapiPoolSlotId: capturedSlotId,
      });
      if (vapiWarnings.length > 0) {
        console.warn(`[freeswitch.voice-status.complete] ${campaignName}: cleanup warnings: ${vapiWarnings.join(" | ")}`);
      }
    }
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
