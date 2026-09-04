/**
 * Mobivate SMS API client.
 *
 * Sends SMS via Mobivate's Bulk API (POST /send/batch with Bearer auth, one recipient per call).
 * Server-side only — NEVER import from client components.
 *
 * 2026-09-04: moved from /send/single to /send/batch at Mobivate's request (relayed by Gisela):
 * only the batch ("campaign") path carries their link tracking, so clicks on the shortened
 * offer link show in their per-campaign report. Dispatch is still one text per call end, so
 * every batch holds exactly ONE recipient and nothing upstream of sendSMS changed. The batch
 * is named after OUR campaign run, so their report groups the way ours does.
 *
 * Manifesto compliance:
 * - Provider-agnostic schema: sms_messages_v2.provider = 'mobivate' (§2 Evolvability)
 * - State written before provider call: caller inserts sms_messages_v2 row THEN calls sendSMS (§6)
 * - Secrets server-only: MOBIVATE_API_KEY never touches the browser (§6 Secrets)
 * - Env vars validated loudly at import time (§2 Zero Trust: "Throw loud on module init")
 *
 * API docs: https://wiki.mobivatebulksms.com
 * Auth: Bearer token in Authorization header
 * Endpoint: POST https://vortex.mobivatebulksms.com/send/batch
 *   (docs: https://wiki.mobivatebulksms.com/sending-sms/send-batch-sms-messages)
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
  /** Our campaign run's name (campaigns_v2.name). Becomes the Mobivate batch/campaign `name`,
   *  so their per-campaign click report lines up with our runs. Omitted when unknown. */
  campaignName?: string | null;
}

export interface SendSMSResult {
  /** Whether Mobivate accepted the request */
  success: boolean;
  /** Mobivate's id for the accepted request — store in sms_messages_v2.provider_message_id.
   *  On /send/batch this is the BATCH id (type BatchSMS), not a per-message id: the batch
   *  answer carries none. The delivery-receipt route matches our `reference` first and then
   *  overwrites provider_message_id with the receipt's real <deliveryMessageId>, so this is a
   *  placeholder for the ~6 s until the receipt lands (the ~6% of texts that never get a receipt
   *  keep the batch id, which still finds the send in Mobivate's portal). */
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
    // ONE recipient per batch: dispatch decides per call end, so a batch is the
    // documented shape wrapped around the single text we already send. `reference`
    // (our sms_messages_v2.id) rides INSIDE the recipient on this endpoint; the
    // delivery receipt echoes it as <clientReference>, which is how the row is found.
    recipients: [{ recipient, reference: args.reference || undefined }],
    // `text` is the documented field on /send/batch. (The 08-27 single-send experiment
    // of sending `text` AND `body` was a shortener probe on the old path; it ends here.)
    text: args.body,
    // Per-brand originator resolved at the call site (VOZ per-brand SMS); the
    // module-load default keeps pre-per-brand callers behaving exactly as before.
    originator: args.originator ?? MOBIVATE_SENDER_ID,
    // The Mobivate campaign name = our run name, so their per-campaign click report
    // groups like ours. Omitted (not "") when the caller has no name.
    ...(args.campaignName ? { name: args.campaignName } : {}),
    // The shortener never fired on NZ single-sends (all 134 delivered NZ messages on the
    // 19 Aug capture billed 2 parts with the full URL); Mobivate says tracking lives on
    // the batch path. Measured after deploy: parts per NZ message must drop to 1.
    shortenUrls: true,
    // /send/single spells this `excludeOptouts`; /send/batch documents `excludeOptOuts`.
    excludeOptOuts: true,
    // The batch path is built for campaigns spread over hours. Ours goes out now;
    // 0 is stated so a provider-side default can never delay a follow-up text.
    spreadHours: 0,
  };

  const url = `https://${MOBIVATE_API_HOST}/send/batch`;

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

    // Acceptance is { success: true, record: { id, type: "BatchSMS", recipientCount } }.
    // record.id is the BATCH id (see SendSMSResult.providerMessageId); the per-message id
    // arrives only on the delivery receipt.
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
