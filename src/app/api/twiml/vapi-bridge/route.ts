/**
 * ⚠️ DEPRECATED 2026-04-15 — Twilio is OUT of scope per Chris.
 *
 * TwiML doesn't apply to the new FreeSWITCH stack. The bridge-to-Vapi behavior
 * is now performed by FreeSWITCH dialplan: infra/freeswitch/dialplan/voizo.xml
 * (the `voizo_bridge_to_vapi` extension).
 *
 * See: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md
 * This route gets removed when the FreeSWITCH PoC is operational.
 */

import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/twiml/vapi-bridge?assistantId=xxx
 *
 * Returns TwiML that bridges the answered call to a Vapi assistant via SIP.
 * Twilio calls this URL when the customer answers.
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawAssistantId = searchParams.get("assistantId") || "voizo-test";

  // H3 fix: sanitize assistantId to prevent XML injection
  // Only allow alphanumeric, hyphens, and underscores
  const assistantId = rawAssistantId.replace(/[^a-zA-Z0-9\-_]/g, "");
  if (!assistantId) {
    return new NextResponse("Invalid assistantId", { status: 400 });
  }

  const sipUri = `sip:${assistantId}@sip.vapi.ai`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Sip>${sipUri}</Sip>
  </Dial>
</Response>`;

  return new NextResponse(twiml, {
    headers: { "Content-Type": "application/xml" },
  });
}

// Twilio may also send GET requests for TwiML
export async function GET(request: NextRequest) {
  return POST(request);
}
