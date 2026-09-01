import { NextRequest, NextResponse } from "next/server";
// Relative imports (vitest does not resolve "@/"; same convention as the sibling
// webhooks/customerio route — keeps this route unit-testable).
import { supabaseAdmin } from "../../../../lib/supabaseServer";
import { parseSigningKeys, verifyCioSignature } from "../../../../lib/customerioWebhookAuth";
import { parseCioEvent, dedupeKeyOf } from "../../../../lib/cioEventPayload";

/**
 * POST /api/webhooks/customerio-events — the player-behaviour ingress (VOZ-454, route A).
 * Spec: .agent/tasks/2026-09-01_SPEC_VOZ454_CIO_Event_Ingress.md
 *
 * Customer.io side: a JOURNEY with trigger = event (e.g. `deposit_made`) and action = Send Webhook.
 *   { "cio_id": "{{customer.cio_id}}", "event_name": "deposit_made",
 *     "occurred_at": "{{event.timestamp}}", "payment_code": "{{event.payment_code}}",
 *     "amount_total": "{{event.human_amount_total}}", "amount_local": "{{event.human_amount}}",
 *     "currency": "{{event.currency}}" }
 * 🔴 The action must be set to "Send Automatically" — its default is Queue Draft, which SILENTLY
 * skips, so the journey looks configured and nothing ever arrives.
 *
 * WHY THIS EXISTS: the Audience surface's deposit figures come from a manual Activities capture
 * today, and that API's window is ~30 days and rolls strictly (measured +6 days over 6 days). One
 * day of player history is lost per day this is not live. Events that arrive here never expire.
 *
 * SEPARATE ROUTE, ON PURPOSE. /api/webhooks/customerio already exists and is the real-time DIAL
 * path (it calls claimAndQueueMember). Reporting ingress must not share a handler with the code
 * that dials: a bug here must be incapable of stopping dialing. No branch was added there.
 *
 * Response contract — mirrors the dial webhook, because Customer.io STOPS RETRYING after about an
 * hour, so a 5xx on a business condition loses the event permanently:
 *   200 stored / duplicate / player-unknown  → stops retries (all are correct outcomes)
 *   400 structurally-broken body             → visible in the Customer.io UI as a template error
 *   401 bad signature or missing key config  → fail closed
 *   5xx ONLY when WE are broken (DB error)   → CIO retries, and the table's PK makes that safe
 *
 * Security posture: the payload is untrusted even after the signature passes. `workspace` is taken
 * from the key that verified the delivery and NEVER from the body — otherwise a valid signature
 * from one brand could write rows attributed to another. Forbidden fields (bin/ip/phone/email/
 * card/pan) are scrubbed inside parseCioEvent, so this route cannot forget to do it.
 * Middleware already exempts /api/webhooks/* from Basic Auth; the signature IS this route's auth.
 *
 * Cost: zero. No Vapi, SquareTalk or Mobivate call. It cannot cause a dial or a text.
 */

/** Postgres unique-violation. The table's primary key is our idempotency door, so this is a
 *  SUCCESS: Customer.io retried, or someone hit Resend, and we already hold the event. */
const PG_UNIQUE_VIOLATION = "23505";

export async function POST(request: NextRequest) {
  // ── 1. Authenticity ──
  const keys = parseSigningKeys(process.env.CUSTOMERIO_WEBHOOK_SIGNING_KEYS);
  const rawBody = await request.text();
  const verdict = verifyCioSignature({
    rawBody,
    timestampHeader: request.headers.get("x-cio-timestamp"),
    signatureHeader: request.headers.get("x-cio-signature"),
    keys,
    nowMs: Date.now(),
  });
  if (!verdict.ok || !verdict.workspace) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── 2. Payload ──
  // Tolerant by design: only cio_id and event_name are required (our own Liquid template controls
  // both). Every other field is best-effort and becomes NULL when absent or unparseable — see
  // cioEventPayload.ts for why nothing here may depend on a guessed attribute name.
  const parsed = parseCioEvent(rawBody, Date.now());
  if (!parsed.ok) {
    console.warn(`[cio-events] rejected body from ${verdict.workspace}: ${parsed.reason}`);
    return NextResponse.json({ error: parsed.reason }, { status: 400 });
  }
  const e = parsed.event;

  // ── 3. Store ──
  const row = {
    workspace: verdict.workspace, // from the SIGNATURE, never the body
    cio_id: e.cioId,
    event_name: e.eventName,
    dedupe_key: dedupeKeyOf({
      paymentCode: e.paymentCode,
      cioId: e.cioId,
      eventName: e.eventName,
      occurredAt: e.occurredAt,
    }),
    occurred_at: e.occurredAt.toISOString(),
    occurred_at_source: e.occurredAtSource,
    amount_norm: e.amountNorm,
    currency: e.currency,
    amount_local: e.amountLocal,
    payload: e.payload,
  };

  const { error } = await supabaseAdmin.from("cio_events").insert(row);

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      console.log(`[cio-events] duplicate ${e.eventName} for ${verdict.workspace} — already held`);
      return NextResponse.json({ received: true, duplicate: true }, { status: 200 });
    }
    // A genuine DB failure. 5xx so Customer.io retries; the PK makes the retry idempotent.
    console.error(`[cio-events] insert failed for ${verdict.workspace}:`, error);
    return NextResponse.json({ error: "Storage failed" }, { status: 500 });
  }

  // The player may be someone we have never dialed — stored anyway. It is real money data about a
  // real player, and the join to a member happens at READ time. Dropping it would silently lose
  // exactly the events that matter most.
  console.log(
    `[cio-events] stored ${e.eventName} ws=${verdict.workspace} at=${row.occurred_at}` +
      ` (${e.occurredAtSource}) amount=${e.amountNorm ?? "-"} ${e.currency ?? ""}`.trimEnd(),
  );
  return NextResponse.json({ received: true, stored: true }, { status: 200 });
}
