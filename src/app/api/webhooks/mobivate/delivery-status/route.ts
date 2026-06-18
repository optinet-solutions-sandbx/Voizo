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
import { supabaseAdmin } from "@/lib/supabaseServer";
import { parseDeliveryReceipt } from "@/lib/mobivateDeliveryReceipt";

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

  const { reference, providerMessageId, status, reason } = parsed;
  console.log(
    `[mobivate/delivery-status] parsed reference=${reference} id=${providerMessageId} status=${status}`,
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
      error_message: status === "delivered" ? null : reason,
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
