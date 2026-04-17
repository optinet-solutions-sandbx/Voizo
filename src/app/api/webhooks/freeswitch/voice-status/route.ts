/**
 * POST /api/webhooks/freeswitch/voice-status
 *
 * Receives call-lifecycle events from the FreeSWITCH webhook shim running
 * alongside the FS instance on AWS. Mirrors the structure of the existing
 * Twilio voice-status handler so the migration is mechanical when FS goes live.
 *
 * STATUS: Phase 0 (2026-04-15) — skeleton only.
 *   - Signature validation: WIRED (uses FREESWITCH_WEBHOOK_SECRET)
 *   - Payload parsing: TODO (depends on the shim's event format — defined in Phase 4)
 *   - Idempotency: TODO (mirror Twilio handler's terminal-status check)
 *   - Chain-next-call: TODO (reuse findNextNumber + originateCall once dialer.ts is migrated)
 *
 * Manifesto §6 compliance plan:
 *   - HMAC validated on every request (no exceptions)
 *   - Idempotent on `voizo_call_id` + status (FS may emit duplicate events on reconnect)
 *   - Returns 200 fast; heavy work happens after
 *   - Suppression + call window checked before chaining next call (via existing dialer.ts helpers)
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §10 (Phase 0)
 */

import { NextRequest, NextResponse } from "next/server";
import { validateFreeSwitchSignature } from "@/lib/freeswitch/validateWebhook";

interface FreeSwitchEvent {
  /** Voizo calls_v2.id — set as voizo_call_id channel variable in originate */
  voizo_call_id?: string;
  /** Voizo campaigns_v2.id */
  voizo_campaign_id?: string;
  /** Voizo campaign_numbers_v2.id */
  voizo_number_id?: string;
  /** FreeSWITCH call UUID (matches calls_v2.provider_call_id) */
  call_uuid?: string;
  /** Event type from the shim — e.g. "CHANNEL_HANGUP_COMPLETE" */
  event_name?: string;
  /** Hangup cause — see https://freeswitch.org/confluence/display/FREESWITCH/Hangup+Cause+Code+Table */
  hangup_cause?: string;
  /** Call duration in seconds (string from FS, parse to int) */
  duration?: string;
  /** ISO timestamp from the FS event */
  timestamp?: string;
}

export async function POST(request: NextRequest) {
  // ── 1. HMAC signature validation (Manifesto §6: no exceptions in prod) ──
  const rawBody = await request.text();
  const signature = request.headers.get("x-freeswitch-signature");

  if (!validateFreeSwitchSignature(rawBody, signature)) {
    console.warn("FreeSWITCH webhook: invalid signature — rejecting");
    return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
  }

  // ── 2. Parse event payload ──
  let event: FreeSwitchEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 3. Required fields check ──
  if (!event.voizo_call_id || !event.event_name) {
    return NextResponse.json(
      { error: "Missing required fields: voizo_call_id, event_name" },
      { status: 400 },
    );
  }

  // ── 4. TODO (Phase 4): map FS event to Voizo status model ──
  // Skeleton only — actual mapping requires the shim's event format finalized.
  // Plan:
  //   - Look up calls_v2 by id = event.voizo_call_id
  //   - Idempotency: if call.status is already terminal, return 200 immediately
  //   - Map hangup_cause → Voizo outcome:
  //       NORMAL_CLEARING        → completed
  //       USER_BUSY              → busy
  //       NO_ANSWER / NO_USER_RESPONSE → no_answer
  //       CALL_REJECTED / NORMAL_TEMPORARY_FAILURE → failed
  //       (others)               → failed
  //   - Update calls_v2 (status, ended_at, duration_seconds, provider_call_id=call_uuid)
  //   - Update campaign_numbers_v2 (attempt_count++, schedule retry or finalize outcome)
  //   - If campaign still running AND within call window:
  //       findNextNumber(campaignId) → originateCall(...) → record new calls_v2 row
  //   - Else: pause/complete campaign

  console.log(
    `[freeswitch.voice-status] STUB received event=${event.event_name} ` +
    `for call=${event.voizo_call_id} (cause=${event.hangup_cause}). ` +
    `Phase 0 — no DB writes yet. Mapping logic lands in Phase 4.`,
  );

  // Return 200 fast (manifesto §6: don't block the shim)
  return NextResponse.json({
    received: true,
    phase: "phase-0-stub",
    event: event.event_name,
  });
}
