/**
 * FreeSWITCH outbound call placement.
 *
 * STATUS: STUB (Phase 0, 2026-04-15) — returns a fake call UUID until the
 * AWS FreeSWITCH instance is provisioned. Real implementation will issue an ESL
 * `originate` command that:
 *   1. Dials the customer's E.164 number through the SquareTalk Sofia profile
 *   2. On answer, transfers the leg into the `voizo_bridge_to_vapi` extension
 *      (see infra/freeswitch/dialplan/voizo.xml) which bridges to the assistant SIP URI
 *   3. Sets channel variables for caller-ID and the Voizo callId so the call-end event
 *      can be correlated back to a calls_v2 row
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §10 (Phase 0 deliverables)
 */

import { getESLConnection } from "./client";

export interface OriginateArgs {
  /** Customer phone in E.164, e.g. "+61412345678" */
  to: string;
  /** Caller ID to present (Remote-Party-ID header). E.164. */
  callerId: string;
  /** Voizo calls_v2.id — propagated as channel variable for webhook correlation */
  callId: string;
  /** Vapi assistant ID — used to construct sip:<assistantId>@sip.vapi.ai for leg 2 */
  vapiAssistantId: string;
  /** Optional: campaign and number IDs for additional logging context */
  campaignId?: string;
  numberId?: string;
}

export interface OriginateResult {
  /** FreeSWITCH UUID for the call — store as calls_v2.provider_call_id */
  providerCallId: string;
}

/**
 * Originate a call through FreeSWITCH → SquareTalk → customer, with on-answer
 * bridge to Vapi.
 *
 * STUB: returns a fake UUID without contacting any real system. Lets dialer.ts
 * be wired without crashing in development.
 *
 * Real ESL command shape (for reference when implementing Phase 4):
 *
 *   originate {
 *     origination_caller_id_number=${callerId},
 *     voizo_call_id=${callId},
 *     voizo_vapi_assistant=${vapiAssistantId}
 *   }sofia/external/+${to}@${SQUARETALK_HOST}:${SQUARETALK_PORT} &transfer(voizo_bridge_to_vapi XML default)
 *
 * The `voizo_bridge_to_vapi` extension lives in infra/freeswitch/dialplan/voizo.xml
 * and reads ${voizo_vapi_assistant} to construct the Vapi SIP URI.
 */
export async function originateCall(args: OriginateArgs): Promise<OriginateResult> {
  const { to, callerId, callId, vapiAssistantId } = args;

  // Validate inputs (defensive — same hygiene as the manifesto §6 demands)
  if (!to.startsWith("+")) throw new Error(`Invalid 'to' — must be E.164 (got: ${to})`);
  if (!callerId.startsWith("+")) throw new Error(`Invalid 'callerId' — must be E.164 (got: ${callerId})`);
  if (!callId) throw new Error("callId is required for webhook correlation");
  if (!vapiAssistantId || !/^[a-zA-Z0-9_-]+$/.test(vapiAssistantId)) {
    throw new Error("vapiAssistantId must be alphanumeric (with - and _ allowed)");
  }

  // STUB MODE: skip the real ESL call, return a fake UUID.
  // Set FREESWITCH_STUB=true in .env.local to keep the stub active during
  // development even after the AWS box is live.
  const stubMode = process.env.FREESWITCH_STUB === "true" || !process.env.FREESWITCH_HOST;
  if (stubMode) {
    const fakeUuid = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    console.warn(
      `[freeswitch.originate] STUB MODE — not contacting FS. Returning fake UUID: ${fakeUuid}. ` +
      `Set FREESWITCH_HOST and unset FREESWITCH_STUB to switch to live mode.`,
    );
    return { providerCallId: fakeUuid };
  }

  // ── Live mode (Phase 4+) ──
  // TODO: implement once the AWS box is reachable and modesl is installed.
  // The shape below is the plan, not yet executable.
  const conn = await getESLConnection();
  try {
    const sqHost = process.env.SQUARETALK_HOST!;
    const sqPort = process.env.SQUARETALK_PORT || "5080";

    const channelVars = [
      `origination_caller_id_number=${callerId}`,
      `voizo_call_id=${callId}`,
      `voizo_vapi_assistant=${vapiAssistantId}`,
      args.campaignId ? `voizo_campaign_id=${args.campaignId}` : null,
      args.numberId ? `voizo_number_id=${args.numberId}` : null,
    ]
      .filter(Boolean)
      .join(",");

    const command = `originate {${channelVars}}sofia/external/+${to.slice(1)}@${sqHost}:${sqPort} &transfer(voizo_bridge_to_vapi XML default)`;

    const jobUuid = await conn.bgapi(command);
    return { providerCallId: jobUuid };
  } finally {
    await conn.disconnect();
  }
}
