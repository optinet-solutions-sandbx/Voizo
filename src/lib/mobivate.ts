/**
 * Mobivate SMS API client.
 *
 * Sends SMS via Mobivate's Bulk API (POST /send/single with Bearer auth).
 * Server-side only — NEVER import from client components.
 *
 * Manifesto compliance:
 * - Provider-agnostic schema: sms_messages_v2.provider = 'mobivate' (§2 Evolvability)
 * - State written before provider call: caller inserts sms_messages_v2 row THEN calls sendSMS (§6)
 * - Secrets server-only: MOBIVATE_API_KEY never touches the browser (§6 Secrets)
 * - Env vars validated loudly at import time (§2 Zero Trust: "Throw loud on module init")
 *
 * API docs: https://wiki.mobivatebulksms.com
 * Auth: Bearer token in Authorization header
 * Endpoint: POST https://<host>/send/single
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md (SMS dispatch section)
 */

// ── Env var validation (manifesto §2: "Throw loud if a required var is missing") ──
// Unlike Twilio/FreeSWITCH, Mobivate vars are optional at startup — the system
// runs without SMS capability until the API key is provided. We validate at
// SEND TIME instead of module-load time so the dashboard doesn't crash on boot
// just because Mobivate isn't configured yet.

const MOBIVATE_API_KEY = process.env.MOBIVATE_API_KEY;
const MOBIVATE_API_HOST = process.env.MOBIVATE_API_HOST;
const MOBIVATE_SENDER_ID = process.env.MOBIVATE_SENDER_ID;

/**
 * Check whether Mobivate is configured. Call this before attempting to send.
 * Returns a descriptive error message if not configured, or null if ready.
 */
export function getMobivateConfigError(): string | null {
  if (!MOBIVATE_API_KEY) return "MOBIVATE_API_KEY is not set";
  if (!MOBIVATE_API_HOST) return "MOBIVATE_API_HOST is not set";
  if (!MOBIVATE_SENDER_ID) return "MOBIVATE_SENDER_ID is not set";
  return null;
}

export interface SendSMSArgs {
  /** Recipient phone number in international format (E.164 without the +, e.g. "61412345678") */
  to: string;
  /** SMS message body */
  body: string;
  /** Our reference ID for delivery receipt correlation (typically the sms_messages_v2.id) */
  reference?: string;
}

export interface SendSMSResult {
  /** Whether Mobivate accepted the request */
  success: boolean;
  /** Mobivate's message ID — store in sms_messages_v2.provider_message_id */
  providerMessageId: string | null;
  /** Error message if failed */
  error: string | null;
}

/**
 * Send a single SMS via Mobivate's Bulk API.
 *
 * Caller is responsible for:
 *   1. Inserting the sms_messages_v2 row with status='queued' BEFORE calling this
 *      (manifesto §6: state written before provider call)
 *   2. Updating the row with the result (provider_message_id, status) AFTER this returns
 *
 * This function does NOT write to the database — it only talks to Mobivate's API.
 * Keeping the DB writes in the caller (the Vapi webhook handler) ensures the
 * transaction boundary is clear and the handler stays idempotent.
 */
export async function sendSMS(args: SendSMSArgs): Promise<SendSMSResult> {
  // ── Pre-flight config check ──
  const configError = getMobivateConfigError();
  if (configError) {
    console.error(`[mobivate.sendSMS] ${configError}. SMS will not be sent.`);
    return { success: false, providerMessageId: null, error: configError };
  }

  // ── Strip leading + from phone number (Mobivate expects MSISDN format: digits only) ──
  const recipient = args.to.startsWith("+") ? args.to.slice(1) : args.to;

  const requestBody = {
    text: args.body,
    originator: MOBIVATE_SENDER_ID,
    recipient,
    reference: args.reference || undefined,
    shortenUrls: true, // confirmed with Maria 2026-04-17 — always on
    excludeOptouts: true, // safety net per manifesto §1 compliance
  };

  const url = `https://${MOBIVATE_API_HOST}/send/single`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${MOBIVATE_API_KEY}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();

    // Mobivate's /send/single success response echoes the request body and adds
    // a top-level `id` field (e.g. "proxied_<ISO-timestamp>"). There is no
    // `success` boolean and no `record` wrapper — verified live on 2026-04-23.
    // Treat HTTP 2xx + non-empty string `id` as acceptance.
    const providerMessageId =
      typeof data.id === "string" && data.id.length > 0 ? data.id : null;

    if (response.ok && providerMessageId) {
      console.log(
        `[mobivate.sendSMS] sent to ${recipient} — id=${providerMessageId}`,
      );
      return { success: true, providerMessageId, error: null };
    }

    // Mobivate returned an error or an unexpected response shape
    const errorMsg = data.message || data.error || `HTTP ${response.status}`;
    console.error(
      `[mobivate.sendSMS] failed for ${recipient} — ${errorMsg}`,
    );
    return { success: false, providerMessageId: null, error: errorMsg };
  } catch (err) {
    // Network error, timeout, DNS failure, etc.
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[mobivate.sendSMS] network error for ${recipient} — ${errorMsg}`,
    );
    return { success: false, providerMessageId: null, error: errorMsg };
  }
}
