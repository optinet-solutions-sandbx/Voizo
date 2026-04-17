/**
 * ⚠️ DEPRECATED 2026-04-15 — Twilio is OUT of scope per Chris (1-on-1, 2026-04-15).
 *
 * Replacement: SquareTalk SIP trunk + self-hosted FreeSWITCH on AWS.
 * See: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md
 *      src/lib/freeswitch/* (the new path)
 *
 * This file stays in the repo so the existing Twilio dialer keeps working until
 * the FreeSWITCH PoC is operational. After Chris approves the migration, this
 * file gets removed in one cleanup commit along with:
 *   - src/app/api/webhooks/twilio/voice-status/route.ts
 *   - src/app/api/twiml/vapi-bridge/route.ts
 *   - all TWILIO_* env vars in .env.local
 *
 * DO NOT add new features here. Bug fixes only if the Twilio path is being kept
 * alive for an active demo.
 */

import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const phoneNumber = process.env.TWILIO_PHONE_NUMBER;

if (!accountSid) throw new Error("FATAL: TWILIO_ACCOUNT_SID is not set");
if (!authToken) throw new Error("FATAL: TWILIO_AUTH_TOKEN is not set");
if (!phoneNumber) throw new Error("FATAL: TWILIO_PHONE_NUMBER is not set");

// After the guards above, these are guaranteed non-null strings.
const _authToken: string = authToken;

export const twilioClient = twilio(accountSid, _authToken);
export const twilioPhoneNumber: string = phoneNumber;

/**
 * Validate incoming Twilio webhook signature.
 * Manifesto §6: "Every Twilio webhook validates X-Twilio-Signature. No exceptions."
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
): boolean {
  return twilio.validateRequest(_authToken, signature, url, params);
}
