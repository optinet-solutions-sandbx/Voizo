/**
 * HMAC-SHA256 signature validation for FreeSWITCH webhook events.
 *
 * STATUS: Phase 0 (2026-04-15). Mirrors the validation patterns used by the
 * existing Twilio (`twilioClient.validateTwilioSignature`) and Vapi
 * (`/api/webhooks/vapi/end-of-call`) handlers so the security model is uniform.
 *
 * Why HMAC and not SIP signatures: FreeSWITCH itself doesn't sign events — we
 * own the webhook shim that translates FS events into HTTP POSTs to the Voizo
 * dashboard. The shim signs the body with a shared secret (FREESWITCH_WEBHOOK_SECRET)
 * before sending. The dashboard validates here.
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md §10 (Phase 0)
 */

import crypto from "crypto";

const WEBHOOK_SECRET = process.env.FREESWITCH_WEBHOOK_SECRET;

/**
 * Validate an incoming FreeSWITCH webhook.
 *
 * @param rawBody Raw request body string (NOT the parsed JSON — must be the
 *                exact bytes the shim signed)
 * @param signature Value of the `x-freeswitch-signature` header
 * @returns true if signature matches, false otherwise.
 *
 * In dev (no FREESWITCH_WEBHOOK_SECRET set), returns true with a warning.
 * Mirrors the Vapi handler's permissive-in-dev posture.
 */
export function validateFreeSwitchSignature(
  rawBody: string,
  signature: string | null,
): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn(
      "[freeswitch.validateWebhook] FREESWITCH_WEBHOOK_SECRET not set — accepting request without validation. " +
      "This is acceptable in dev but MUST be set before production. See manifesto §6.",
    );
    return true;
  }

  if (!signature) {
    console.warn("[freeswitch.validateWebhook] No x-freeswitch-signature header — rejecting");
    return false;
  }

  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    // Buffer length mismatch (signature is malformed) — reject
    return false;
  }
}
