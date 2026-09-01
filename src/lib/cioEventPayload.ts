// Customer.io event payload parsing (VOZ-454 route A).
// Spec: .agent/tasks/2026-09-01_SPEC_VOZ454_CIO_Event_Ingress.md
//
// TOLERANT BY DESIGN, and that is the central decision.
//
// The attribute names Customer.io sends are NOT verified from a captured payload — they come from a
// design discussion (payment_code / human_amount_total / human_amount / server_tag). The Mobivate DLR
// parser was written from documentation that said JSON when reality was a form field
// `xml=<deliveryreceipt>`; every receipt was silently dropped for four months, 328 texts stuck at
// 'sent', zero delivery confirmation, and nobody knew.
//
// So nothing here depends on a guessed field name being right:
//   - REQUIRED: cio_id + event_name only. We control both in our own Liquid template, so they are
//     the only fields we can actually promise.
//   - EVERYTHING ELSE: best effort. A field that is missing, misnamed or unparseable becomes NULL —
//     "unknown", never a zero, never a guess.
//   - The full (scrubbed) body is persisted, so the production payload teaches us the real shape and
//     a newly-relevant field needs no migration.
//
// Pure module (crypto only, no I/O) so vitest locks the contract without env or a database — same
// posture as customerioWebhookAuth.ts.

import { createHash } from "crypto";

/** Never persisted, not even inside the raw jsonb. Matched case-insensitively, at any depth. */
export const CIO_FORBIDDEN_FIELDS = [
  "bin",
  "ip",
  "ip_address",
  "phone",
  "email",
  "card",
  "pan",
] as const;

const FORBIDDEN = new Set<string>(CIO_FORBIDDEN_FIELDS.map((f) => f.toLowerCase()));

/** Plausible event-time band. Outside it we do not believe the payload's timestamp. */
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

export interface CioEvent {
  cioId: string;
  eventName: string;
  occurredAt: Date;
  /** 'received' = the payload had no usable timestamp and this is OUR clock. Persisted so a chart
   *  can never silently present a receipt time as an event time. */
  occurredAtSource: "payload" | "received";
  /** Comparable total. NULL when absent or unparseable — a missing amount is unknown, not zero. */
  amountNorm: number | null;
  currency: string | null;
  /** Local-currency amount kept as TEXT, verbatim. Coercing invites an AUD+CAD total, which is not
   *  a real number — the Audience surface holds one figure per currency, forever. */
  amountLocal: string | null;
  /** For the dedupe key. Not persisted as its own column; it lives in the payload. */
  paymentCode: string | null;
  /** The delivery as received, minus CIO_FORBIDDEN_FIELDS. */
  payload: unknown;
}

export type CioParseResult =
  | { ok: true; event: CioEvent }
  | { ok: false; reason: string };

/** Recursively drop every forbidden field. Objects and arrays are rebuilt; primitives pass through. */
export function scrubPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubPayload);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN.has(k.toLowerCase())) continue;
    out[k] = scrubPayload(v);
  }
  return out;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * Strict string, for the two fields that form the join key and the primary key. Deliberately does
 * NOT coerce a number: cio_ids are hex strings that can carry leading zeros (`bdba0906…`), so
 * stringifying a JSON number could silently drop one and produce an id that matches no member.
 * A silent join failure is far worse than a loud 400 — the 400 is visible in the Customer.io UI.
 */
function strictStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Best-effort numeric. Tolerates thousands separators and currency noise; refuses anything else. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const cleaned = v.replace(/[^\d.-]/g, "");
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

const inBand = (d: Date): boolean => {
  const y = d.getUTCFullYear();
  return Number.isFinite(d.getTime()) && y >= MIN_YEAR && y <= MAX_YEAR;
};

/**
 * Customer.io documents epoch SECONDS. We accept seconds, milliseconds and ISO, then sanity-check
 * the year — because the ms/s mix-up is silent in both directions (seconds read as ms land in 1970;
 * ms read as seconds land around the year 57000) and no downstream chart catches either.
 * Returns null when the value cannot be believed; the caller falls back to receipt time and records
 * that it did.
 */
function parseTimestamp(v: unknown): Date | null {
  if (typeof v === "number" || (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v))) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    const asSeconds = new Date(n * 1000);
    if (inBand(asSeconds)) return asSeconds;
    const asMillis = new Date(n);
    if (inBand(asMillis)) return asMillis;
    return null;
  }
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v.trim());
    if (inBand(d)) return d;
  }
  return null;
}

/**
 * The idempotency key. Customer.io retries deliveries AND its UI has a Resend button, so duplicates
 * are certain rather than hypothetical. `payment_code` is the natural key on money events; when it is
 * absent we hash the identity triple so the same delivery twice yields the same key.
 *
 * Ceiling (deliberate): two genuinely distinct non-deposit events in the same second for one player
 * collapse into one row. Money events carry payment_code, and a same-second repeat on a neutral event
 * is a retry in practice.
 */
export function dedupeKeyOf(args: {
  paymentCode: string | null;
  cioId: string;
  eventName: string;
  occurredAt: Date;
}): string {
  const code = args.paymentCode?.trim();
  if (code) return code;
  return createHash("sha256")
    .update(`${args.cioId}|${args.eventName}|${args.occurredAt.toISOString()}`)
    .digest("hex");
}

/**
 * Parse a raw Customer.io webhook body.
 *
 * `receivedAtMs` is passed in rather than read from the clock so the parser stays pure and the
 * fallback timestamp is testable without mocking time.
 */
export function parseCioEvent(rawBody: string, receivedAtMs: number): CioParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "Body is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "Body must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  // The only two fields we can promise: our own Liquid template sets them.
  const cioId = strictStr(obj.cio_id);
  const eventName = strictStr(obj.event_name);
  if (!cioId) return { ok: false, reason: "cio_id is required (string)" };
  if (!eventName) return { ok: false, reason: "event_name is required (string)" };

  // Best effort from here down. Alternate spellings are tried because the exact attribute names are
  // unconfirmed; each is a NAME guess only — no VALUE is ever invented.
  const tsRaw = obj.occurred_at ?? obj.timestamp ?? obj.event_timestamp;
  const fromPayload = parseTimestamp(tsRaw);
  const occurredAt = fromPayload ?? new Date(receivedAtMs);
  const occurredAtSource: "payload" | "received" = fromPayload ? "payload" : "received";

  const amountNorm = num(obj.amount_total ?? obj.human_amount_total);
  const amountLocal = str(obj.amount_local ?? obj.human_amount);
  const currency = str(obj.currency)?.toUpperCase() ?? null;
  const paymentCode = str(obj.payment_code);

  return {
    ok: true,
    event: {
      cioId,
      eventName,
      occurredAt,
      occurredAtSource,
      amountNorm,
      currency,
      amountLocal,
      paymentCode,
      // Scrubbed HERE, not in the route, so a caller cannot forget it.
      payload: scrubPayload(obj),
    },
  };
}
