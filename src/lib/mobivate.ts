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
 * Endpoint: POST https://vortex.mobivatebulksms.com/send/single
 *
 * Spec: docs/2026-04-15_SPEC_FreeSWITCH_Pitch_MVP.md (SMS dispatch section)
 */

import { CIO_DEFAULT_WORKSPACE } from "./customerio";

// ── Env var validation (manifesto §2: "Throw loud if a required var is missing") ──
// Unlike FreeSWITCH, Mobivate vars are optional at startup — the system
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

/**
 * Per-brand SMS originator (sender ID). The brand is the campaigns_v2.cio_workspace
 * label (VOZ-198); this mirrors resolveAppApiKey so a reviewer reads it the same way:
 *
 *   - Reads env at CALL time (tests steer it; the dashboard boots unconfigured).
 *   - Map env MOBIVATE_SENDER_IDS = {"lucky7even":"Lucky7even","fortuneplay":"FortunePlay"}
 *     — the same {brand label → value} shape as CUSTOMERIO_APP_API_KEYS, labels MUST
 *     match that map + campaigns_v2.cio_workspace.
 *   - The legacy single MOBIVATE_SENDER_ID is the fallback for the DEFAULT brand ONLY.
 *   - A non-default brand NEVER borrows the default sender: that would send brand A's
 *     offer under brand B's name (the exact wrong-brand/consent bug this fixes). Fail
 *     closed instead.
 */
function parseSenderIdMap(): Record<string, unknown> {
  const rawMap = process.env.MOBIVATE_SENDER_IDS;
  if (!rawMap) return {};
  try {
    const parsed: unknown = JSON.parse(rawMap);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through — malformed map: default brand still uses the legacy key, others fail closed
  }
  return {};
}

export function resolveSmsSenderId(
  workspace?: string | null,
): { senderId: string; error: null } | { senderId: null; error: string } {
  const ws = (workspace ?? "").trim() || CIO_DEFAULT_WORKSPACE;
  const map = parseSenderIdMap();
  const entry = map[ws];
  if (typeof entry === "string" && entry.trim().length > 0) {
    return { senderId: entry, error: null };
  }
  if (ws === CIO_DEFAULT_WORKSPACE) {
    const legacy = process.env.MOBIVATE_SENDER_ID;
    if (legacy) return { senderId: legacy, error: null };
    return { senderId: null, error: "MOBIVATE_SENDER_ID is not set" };
  }
  return { senderId: null, error: `MOBIVATE_SENDER_IDS has no sender for workspace '${ws}'` };
}

export interface SendSMSArgs {
  /** Recipient phone number in international format (E.164 without the +, e.g. "61412345678") */
  to: string;
  /** SMS message body */
  body: string;
  /** Our reference ID for delivery receipt correlation (typically the sms_messages_v2.id) */
  reference?: string;
  /** Per-brand sender ID (originator). Resolve via resolveSmsSenderId(cio_workspace)
   *  at the call site and pass it here. Omitted → the legacy default MOBIVATE_SENDER_ID
   *  (backward-compatible with pre-per-brand callers). */
  originator?: string;
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
    // BOTH message fields, same content, on purpose (2026-08-27).
    //
    // Mobivate's docs name this field `text`; we have sent `body` since the
    // integration was written, and messages deliver, so their send path accepts
    // it. But `shortenUrls: true` (on since 8420c70, 2026-05-04) fires only
    // SOMETIMES: measured over the 19 Aug capture, AU averaged 1.29 billed parts
    // per message (mostly shortened) while all 134 delivered NZ messages billed
    // 2 parts with the full 64-char URL still in Mobivate's own stored text (0
    // shortened). Another integration on the same account gets `cllk.me` links on
    // single-sends, so the feature works there. The most likely difference we can
    // see is this field name: a shortener reading the documented `text` would
    // never see a body-only payload, while the sender falls back to `body`.
    //
    // Populating both is the safe test of that: if they only ever read `body`,
    // nothing changes; if the shortener wants `text`, it starts firing. Sending
    // `text` ALONE would risk every SMS if some middleware needs `body`.
    // Unshortened messages cross the 160-char line and bill double — about 37%
    // of parts on that capture were avoidable second parts, and NZ is the
    // priciest lane at EUR 0.11 per delivered message.
    // REVERT THIS if Mobivate confirms the field is irrelevant and names the
    // real cause (country, sender ID, or destination domain).
    text: args.body,
    body: args.body,
    // Per-brand originator resolved at the call site (VOZ per-brand SMS); the
    // module-load default keeps pre-per-brand callers behaving exactly as before.
    originator: args.originator ?? MOBIVATE_SENDER_ID,
    recipient,
    shortenUrls: true,
    excludeOptouts: true,
    reference: args.reference || undefined,
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
      // A Mobivate hang must not ride the serverless function into its
      // maxDuration kill — that strands the sms row at 'queued' forever
      // (2026-06-12 review H1). Abort -> catch below -> success:false ->
      // caller marks 'failed' -> a later attempt may retry the send.
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json();

    // Working Mobivate API path for this account uses the vortex host and
    // returns { success: true, record: { id, ... } } on acceptance.
    const providerMessageId =
      typeof data.record?.id === "string" && data.record.id.length > 0
        ? data.record.id
        : null;

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
