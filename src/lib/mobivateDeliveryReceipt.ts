// Parse Mobivate delivery receipts (DLRs) into our normalized shape.
//
// Mobivate (vortex) posts DLRs as a form-encoded body with a single field `xml`
// holding a URL-encoded <deliveryreceipt> document, e.g. (decoded):
//   xml=<deliveryreceipt>
//         <created>2026-06-18T11:00:15.915Z</created>
//         <deliveryMessageId>133e4f21-...</deliveryMessageId>   ← provider id (our provider_message_id)
//         <clientReference>f1c2a2bd-...</clientReference>       ← OUR echo (sms_messages_v2.id)
//         <status>DELIVERED</status>
//         <statusCode>1</statusCode><part>1</part><parts>1</parts>
//       </deliveryreceipt>
// The original handler only tried JSON / plain form fields, so every receipt fell through to
// "unrecognized body format" and was dropped (328 SMS stuck at 'sent', 0 delivery confirmation).
//
// Pure + side-effect-free so it unit-tests against real captured payloads without the
// service-role singleton (same pattern as draftPriority.ts / stuckSweep.ts). The route handler
// owns the DB match + update.

export type SmsStatus = "queued" | "sent" | "delivered" | "failed" | "undelivered";

/**
 * Normalize a provider status string to our sms_messages_v2.status enum. Anything
 * unrecognized → 'failed' (surface problems, never leave ambiguous in 'sent').
 */
export function normalizeSmsStatus(raw: unknown): SmsStatus {
  if (typeof raw !== "string") return "failed";
  const s = raw.trim().toUpperCase();
  if (s === "DELIVERED" || s === "DELIVRD") return "delivered";
  if (s === "UNDELIVERED" || s === "UNDELIVERABLE") return "undelivered";
  if (s === "ACCEPTED" || s === "SENT" || s === "ENROUTE") return "sent";
  return "failed"; // EXPIRED / REJECTED / UNKNOWN / anything else
}

export interface ParsedReceipt {
  /** Our sms_messages_v2.id — Mobivate's <clientReference> (or `reference` in JSON/form). */
  reference: string | null;
  /** Mobivate's message id — <deliveryMessageId> (or `id`). Maps to provider_message_id. */
  providerMessageId: string | null;
  /** Normalized status. */
  status: SmsStatus;
  /** Provider statusCode, if present (informational). */
  statusCode: string | null;
  /** Failure reason, if the provider supplied one (informational). */
  reason: string | null;
}

/** Extract the first <tag>…</tag> text (case-insensitive, non-nested). */
function xmlTag(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`, "i").exec(xml);
  return m ? m[1].trim() || null : null;
}

function fromXml(xml: string): ParsedReceipt {
  return {
    reference: xmlTag(xml, "clientReference"),
    providerMessageId: xmlTag(xml, "deliveryMessageId"),
    status: normalizeSmsStatus(xmlTag(xml, "status")),
    statusCode: xmlTag(xml, "statusCode"),
    reason: xmlTag(xml, "reason"),
  };
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Parse a raw Mobivate DLR body. Returns null only when the body is in no recognized
 * format (the caller logs + 200s those so Mobivate doesn't retry-storm).
 *
 * Recognizes, in order:
 *   1. JSON  { reference, id, status, reason }
 *   2. Mobivate XML — form field `xml=<deliveryreceipt>…`, or a raw <deliveryreceipt> body
 *   3. Legacy plain form — reference=…&id=…&status=…
 */
export function parseDeliveryReceipt(rawBody: string): ParsedReceipt | null {
  if (!rawBody || !rawBody.trim()) return null;

  // 1. JSON
  try {
    const j = JSON.parse(rawBody) as Record<string, unknown>;
    if (j && typeof j === "object") {
      return {
        reference: strOrNull(j.reference),
        providerMessageId: strOrNull(j.id),
        status: normalizeSmsStatus(j.status),
        statusCode: strOrNull(j.statusCode),
        reason: strOrNull(j.reason),
      };
    }
  } catch {
    // not JSON — fall through
  }

  // 2 & 3. form-encoded (or raw XML)
  let params: URLSearchParams | null = null;
  try {
    params = new URLSearchParams(rawBody);
  } catch {
    params = null;
  }

  // 2a. Mobivate XML wrapped in an `xml` form field
  const xmlField = params?.get("xml");
  if (xmlField && /<deliveryreceipt/i.test(xmlField)) {
    return fromXml(xmlField);
  }

  // 3. Legacy plain form fields
  if (params && (params.has("id") || params.has("reference") || params.has("status"))) {
    return {
      reference: strOrNull(params.get("reference")),
      providerMessageId: strOrNull(params.get("id")),
      status: normalizeSmsStatus(params.get("status")),
      statusCode: strOrNull(params.get("statusCode")),
      reason: strOrNull(params.get("reason")),
    };
  }

  // 2b. Raw XML body (no `xml=` wrapper) — best-effort decode then parse
  if (/<deliveryreceipt|%3Cdeliveryreceipt/i.test(rawBody)) {
    let xml = rawBody;
    try {
      xml = decodeURIComponent(rawBody);
    } catch {
      // keep rawBody as-is if it isn't valid percent-encoding
    }
    if (/<deliveryreceipt/i.test(xml)) return fromXml(xml);
  }

  return null;
}
