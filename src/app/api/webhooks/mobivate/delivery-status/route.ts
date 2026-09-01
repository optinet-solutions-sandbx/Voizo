/**
 * POST /api/webhooks/mobivate/delivery-status
 *
 * Receives Mobivate delivery receipts and updates sms_messages_v2.status.
 *
 * Security note: Mobivate does not sign delivery-receipt callbacks. We validate
 * by matching the payload's `reference` (our sms_messages_v2.id UUID, set at
 * send time) against the DB. Unknown references are logged and 200'd — we
 * never 500 back to Mobivate, since retries would pile up without fixing the
 * underlying mismatch.
 *
 * Payload shape (CONFIRMED from prod logs 2026-06-18): a form-encoded body with one `xml`
 * field holding a URL-encoded <deliveryreceipt> document:
 *   xml=<deliveryreceipt>
 *         <deliveryMessageId>…</deliveryMessageId>   // provider id  -> provider_message_id
 *         <clientReference>…</clientReference>        // our echo     -> sms_messages_v2.id (match key)
 *         <status>DELIVERED|UNDELIVERED|…</status>
 *         <statusCode>…</statusCode><part>…</part><parts>…</parts>
 *       </deliveryreceipt>
 * Parsing (incl. JSON + legacy-form fallbacks) lives in lib/mobivateDeliveryReceipt.ts (unit-tested
 * against real captured payloads). Before this fix the handler only tried JSON/plain-form, so every
 * receipt dropped as "unrecognized body format" and all SMS stuck at 'sent'.
 *
 * Spec: .agent/tasks/2026-04-16_TASK_SMS_Mobivate_CustomerIO.md (delivery receipts)
 */

import { NextRequest, NextResponse } from "next/server";
// Relative, not "@/" — vitest has no alias config, so a route importing "@/lib/..." cannot be
// unit-tested at all. Same resolved modules; this is the convention every tested route here
// follows (see the sibling webhooks/customerio route + its test).
import { supabaseAdmin } from "../../../../../lib/supabaseServer";
import { parseDeliveryReceipt, describeFailure } from "../../../../../lib/mobivateDeliveryReceipt";

export async function POST(request: NextRequest) {
  // Parsing (JSON / Mobivate `xml=`-wrapped XML / legacy form) lives in the pure,
  // unit-tested parseDeliveryReceipt. Returns null only for genuinely unrecognized
  // bodies — 200 those (never 500) so Mobivate doesn't retry-storm.
  const rawBody = await request.text();
  const parsed = parseDeliveryReceipt(rawBody);

  if (!parsed) {
    console.warn("[mobivate/delivery-status] unrecognized body format:", rawBody.slice(0, 500));
    return NextResponse.json({ received: true, parsed: false }, { status: 200 });
  }

  const { reference, providerMessageId, status } = parsed;
  // VOZ-250: the cause, for the error_message column. Mobivate sends <status> + <statusCode> and
  // no <reason>, so the old `reason`-only write left error_message NULL on all 667 non-delivered
  // rows — we could say a text failed, never why. describeFailure keeps the provider's own words.
  //
  // Gated on the TERMINAL FAILURE states, not on `!== "delivered"`: normalizeSmsStatus maps
  // ACCEPTED / SENT / ENROUTE to 'sent', so an interim receipt on a message still in flight would
  // otherwise stamp error_message="ACCEPTED (code 1)" — an error string on a non-error, read
  // verbatim by the dashboard and the CSV exports. 'queued'/'sent' are not failures; keep them NULL.
  const isFailure = status === "failed" || status === "undelivered";
  const failureDetail = isFailure ? describeFailure(parsed) : null;
  console.log(
    `[mobivate/delivery-status] parsed reference=${reference} id=${providerMessageId} status=${status}` +
      ` raw=${parsed.rawStatus ?? "-"} code=${parsed.statusCode ?? "-"}`,
  );

  // Match on `reference` (our UUID) first — it's what we set at send time.
  // Fall back to provider_message_id in case Mobivate sometimes omits `reference`.
  let row: { id: string } | null = null;

  if (reference) {
    const { data } = await supabaseAdmin
      .from("sms_messages_v2")
      .select("id")
      .eq("id", reference)
      .maybeSingle();
    row = data;
  }

  if (!row && providerMessageId) {
    const { data } = await supabaseAdmin
      .from("sms_messages_v2")
      .select("id")
      .eq("provider_message_id", providerMessageId)
      .maybeSingle();
    row = data;
  }

  if (!row) {
    console.warn(
      `[mobivate/delivery-status] no match — reference=${reference} providerMessageId=${providerMessageId}`,
    );
    return NextResponse.json({ received: true, matched: false }, { status: 200 });
  }

  const { error } = await supabaseAdmin
    .from("sms_messages_v2")
    .update({
      status,
      error_message: failureDetail,
      ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
    })
    .eq("id", row.id);

  if (error) {
    console.error(`[mobivate/delivery-status] supabase update failed:`, error);
    return NextResponse.json({ received: true, matched: true, updated: false }, { status: 200 });
  }

  console.log(`[mobivate/delivery-status] updated sms=${row.id} → ${status}`);
  return NextResponse.json({ received: true, matched: true, updated: true, status }, { status: 200 });
}
