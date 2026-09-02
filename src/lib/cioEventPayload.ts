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

/**
 * Timestamp attribute names, in order of authority. The first three are what OUR Liquid template
 * sets, so they stay ahead. `created_at` is what Customer.io itself actually sends — confirmed on
 * two captured bodies — which is why every event before VOZ-476 fell back to our receipt clock.
 *
 * ⚠ `created_at` arrives as epoch SECONDS on deposit_made and as a HUMAN STRING
 * ("August 10, 2026 07:58") on deposit_canceled: one field name, two formats, two event types.
 * parseTimestamp's band-checked multi-format handling is what copes — do not "simplify" it.
 */
const TIMESTAMP_FIELDS = ["occurred_at", "timestamp", "event_timestamp", "created_at"] as const;

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
  /** An explicit idempotency key set by the CRM template (VOZ-476). Outranks everything. NULL when
   *  the template does not set one, which leaves the pre-existing chain exactly as it was. */
  dedupeKey: string | null;
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

/**
 * An UNRENDERED Liquid tag. Customer.io's "Test response" button (and any journey whose trigger
 * carries no event) sends the webhook body with the template text intact — "{{customer.cio_id}}"
 * arrives where an id should be. Found on the first live delivery, 2026-09-02: the ingress stored a
 * row whose cio_id was a Liquid tag, whose dedupe_key was "{{event.payment_code}}" (so every later
 * test would collide with it) and whose currency had been upper-cased to "{{EVENT.CURRENCY}}".
 * Only the opening double-brace counts — a rendered value may legitimately contain single braces,
 * and a stray "}}" without its opener is data, not a tag. (Matching "}}" too survived a mutation
 * pass as dead code: no real body has a closer without an opener, so it never decided anything.)
 */
const UNRENDERED_LIQUID = /\{\{/;
const isUnrendered = (v: unknown): boolean => typeof v === "string" && UNRENDERED_LIQUID.test(v);

/** Best-effort string. An unrendered template is UNKNOWN, never a value. */
function str(v: unknown): string | null {
  if (isUnrendered(v)) return null;
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
  if (isUnrendered(v)) return null;
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
 * are certain rather than hypothetical.
 *
 * Precedence, widest authority first (VOZ-476):
 *   1. `dedupe_key` set by the CRM template — the template knows what makes THIS event unique.
 *   2. `payment_code` — the natural key on money events.
 *   3. A hash of the identity triple, so the same delivery twice yields the same key.
 *
 * The explicit key was added because step 3 collapses same-second bursts: two `segment_entered`
 * events one second apart (routine — a profile shows "Entered 1 and exited 6 segment(s)") hash
 * identically and the second row is silently refused by the primary key. Deposits were never at
 * risk; segment and bonus events were, which blocked the whole class. A template setting
 * "{{customer.cio_id}}-seg-{{event.segment}}-{{event.timestamp}}" now controls its own uniqueness.
 *
 * Ceiling (unchanged, now opt-out rather than forced): a template that sets NO dedupe_key on a
 * non-money event still collapses same-second duplicates.
 */
export function dedupeKeyOf(args: {
  paymentCode: string | null;
  cioId: string;
  eventName: string;
  occurredAt: Date;
  /** Optional so the pre-VOZ-476 call shape stays valid. */
  dedupeKey?: string | null;
}): string {
  // Trimmed, because trailing whitespace from a Liquid render would otherwise mint a second row
  // for an event we already hold — the exact duplicate this key exists to prevent.
  const explicit = args.dedupeKey?.trim();
  if (explicit) return explicit;
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
  // An unrendered tag gets its OWN reason: this string is what the CRM team reads in the Customer.io
  // delivery log, and "is required" would send them looking for a missing field that is plainly
  // present. The fix is on their side (the journey has no event in scope) and the message says so.
  const unrenderedReason = (field: string) =>
    `${field} is an unrendered Liquid template tag — the webhook body was sent without an event in scope (Test response, or a non-event trigger); check the journey trigger and template`;
  if (isUnrendered(obj.cio_id)) return { ok: false, reason: unrenderedReason("cio_id") };
  if (isUnrendered(obj.event_name)) return { ok: false, reason: unrenderedReason("event_name") };
  const cioId = strictStr(obj.cio_id);
  const eventName = strictStr(obj.event_name);
  if (!cioId) return { ok: false, reason: "cio_id is required (string)" };
  if (!eventName) return { ok: false, reason: "event_name is required (string)" };

  // Best effort from here down. Alternate spellings are tried because the exact attribute names are
  // unconfirmed; each is a NAME guess only — no VALUE is ever invented.
  //
  // FIRST THAT PARSES, not first that is present (VOZ-476). `??` falls through on null/undefined
  // only, and Liquid renders a missing variable as an EMPTY STRING — so a template carrying
  // "occurred_at": "{{event.timestamp}}" with no event.timestamp sends occurred_at:"". That would
  // win a `??` chain, fail to parse, and stamp the event with our receipt clock while a perfectly
  // good created_at sat unread two fields away.
  const fromPayload = TIMESTAMP_FIELDS.reduce<Date | null>(
    (found, field) => found ?? parseTimestamp(obj[field]),
    null,
  );
  const occurredAt = fromPayload ?? new Date(receivedAtMs);
  const occurredAtSource: "payload" | "received" = fromPayload ? "payload" : "received";

  const amountNorm = num(obj.amount_total ?? obj.human_amount_total);
  const amountLocal = str(obj.amount_local ?? obj.human_amount);
  const currency = str(obj.currency)?.toUpperCase() ?? null;
  const paymentCode = str(obj.payment_code);
  // strictStr, not str: a dedupe key is a primary-key component, so a JSON number must not be
  // coerced into one — same reasoning as cio_id. Blank or non-string becomes null and the
  // pre-existing fallback chain runs untouched.
  const dedupeKey = strictStr(obj.dedupe_key);

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
      dedupeKey,
      // Scrubbed HERE, not in the route, so a caller cannot forget it.
      payload: scrubPayload(obj),
    },
  };
}
