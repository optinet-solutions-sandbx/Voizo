/**
 * POST /api/freeswitch/originate
 *
 * Standalone trigger endpoint for placing a single outbound call via FreeSWITCH.
 * Used during the PoC pitch to demo the end-to-end call flow with one curl command.
 *
 * STATUS: Phase 0 (2026-04-15). In stub mode (no FREESWITCH_HOST set) this returns
 * a fake call UUID without contacting FS. Once the AWS box is live and env vars
 * are filled in, it places real calls.
 *
 * This endpoint is SEPARATE from the campaign-dial flow
 * (/api/campaigns-v2/[id]/start). It exists to:
 *   1. Let us trigger a single call without having a campaign in the DB
 *   2. Provide a simple curl target for the 90-sec pitch demo video
 *   3. Let us smoke-test the FS bridge to Vapi before plumbing the full dashboard
 *
 * Future: campaign-dial flow will also use originateCall() via dialer.ts — that's
 * a separate migration when FS is operational (see spec §8 "refactor plan").
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §6 Phase 4
 *
 * Example usage:
 *   curl -X POST http://localhost:3001/api/freeswitch/originate \
 *     -H 'content-type: application/json' \
 *     -H 'x-auth-secret: ${FREESWITCH_WEBHOOK_SECRET}' \
 *     -d '{"to":"+639171234567","callerId":"+12345678901","vapiSipIdentifier":"voizo-poc"}'
 *
 * Response (success):
 *   { "ok": true, "providerCallId": "...", "bridgeTo": "sip:voizo-poc@sip.vapi.ai" }
 */

import { NextRequest, NextResponse } from "next/server";
import { originateCall } from "@/lib/freeswitch/originate";

const AUTH_SECRET = process.env.FREESWITCH_WEBHOOK_SECRET;

interface TriggerBody {
  /** Customer phone in E.164 — the number to dial */
  to?: string;
  /** Caller ID to present (Remote-Party-ID SIP header). E.164. */
  callerId?: string;
  /** SIP identifier created in Vapi (e.g. "voizo-poc"). Constructs sip:<id>@sip.vapi.ai for leg 2. */
  vapiSipIdentifier?: string;
  /** Free-form note for logging — optional */
  note?: string;
}

/**
 * E.164 sanity check — starts with +, followed by 7–15 digits. Permissive; not a
 * full E.164 validator. Full validation happens at FS send time.
 */
function isValidE164(s: string): boolean {
  return /^\+\d{7,15}$/.test(s);
}

/**
 * SIP identifier sanity check — alphanumeric, hyphens, underscores. Matches
 * Vapi's UI-accepted pattern and prevents any injection into the FS bridge URI.
 */
function isValidSipIdentifier(s: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(s);
}

export async function POST(request: NextRequest) {
  // ── Auth: require shared secret if FREESWITCH_WEBHOOK_SECRET is set ──
  // PoC-grade auth. Matches the same secret used for webhook HMAC so we only
  // maintain one credential. In production this endpoint would sit behind proper
  // auth (session, IAM, or just remove it entirely once the dashboard drives dialing).
  if (AUTH_SECRET) {
    const provided = request.headers.get("x-auth-secret");
    if (provided !== AUTH_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else {
    console.warn(
      "[freeswitch.originate trigger] FREESWITCH_WEBHOOK_SECRET not set — endpoint is OPEN. " +
      "Acceptable in dev; MUST be set before the dashboard is publicly reachable.",
    );
  }

  // ── Parse body ──
  let body: TriggerBody;
  try {
    body = (await request.json()) as TriggerBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const to = body.to?.trim();
  const callerId = body.callerId?.trim();
  const vapiSipIdentifier = (body.vapiSipIdentifier ?? process.env.VAPI_SIP_IDENTIFIER ?? "voizo-poc").trim();

  // ── Validate ──
  if (!to || !isValidE164(to)) {
    return NextResponse.json(
      { error: "'to' is required and must be E.164 (e.g. '+639171234567')" },
      { status: 400 },
    );
  }
  if (!callerId || !isValidE164(callerId)) {
    return NextResponse.json(
      { error: "'callerId' is required and must be E.164 (e.g. '+12345678901')" },
      { status: 400 },
    );
  }
  if (!isValidSipIdentifier(vapiSipIdentifier)) {
    return NextResponse.json(
      { error: "'vapiSipIdentifier' must be alphanumeric (+ hyphens/underscores), max 64 chars" },
      { status: 400 },
    );
  }

  // ── Generate a Voizo-side call ID ──
  // Standalone mode: we don't write to calls_v2 (no campaign context). The shim
  // webhook will arrive with this voizo_call_id and we'll log it without DB writes.
  // When campaign-dial flow uses this endpoint (future), campaign_id + number_id
  // will be passed in and we'll insert a calls_v2 row first (manifesto §6: state
  // before provider call).
  const voizoCallId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  // ── Fire the call ──
  try {
    const { providerCallId } = await originateCall({
      to,
      callerId,
      callId: voizoCallId,
      vapiAssistantId: vapiSipIdentifier, // note: param is named "vapiAssistantId" in
                                          // originate.ts but it's actually the SIP
                                          // identifier — rename pass queued for Phase 1
    });

    const bridgeTo = `sip:${vapiSipIdentifier}@sip.vapi.ai`;
    console.log(
      `[freeswitch.originate trigger] call placed — to=${to} callerId=${callerId} ` +
      `bridgeTo=${bridgeTo} voizoCallId=${voizoCallId} providerCallId=${providerCallId}` +
      (body.note ? ` note="${body.note}"` : ""),
    );

    return NextResponse.json({
      ok: true,
      voizoCallId,
      providerCallId,
      bridgeTo,
      stub: providerCallId.startsWith("stub-"),
      note: body.note ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[freeswitch.originate trigger] failed — ${message}`);
    return NextResponse.json(
      { error: "Failed to place call", detail: message },
      { status: 500 },
    );
  }
}
