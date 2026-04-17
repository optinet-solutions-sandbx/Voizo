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
 * Payload shape (Mobivate Bulk SMS delivery receipts):
 *   {
 *     id: string,          // Mobivate's message id (maps to provider_message_id)
 *     reference: string,   // Our echo — the sms_messages_v2.id we set in sendSMS()
 *     status: string,      // DELIVERED | UNDELIVERED | FAILED | EXPIRED | REJECTED | ACCEPTED | UNKNOWN
 *     statusCode?: string,
 *     recipient?: string,
 *     timestamp?: string,
 *     reason?: string,
 *   }
 *
 * Note: Exact field names are best-guess from Mobivate's Bulk SMS wiki. The
 * handler logs the full raw payload on first receipt so we can confirm shape
 * from live traffic and tighten this comment.
 *
 * Spec: .agent/tasks/2026-04-16_TASK_SMS_Mobivate_CustomerIO.md (delivery receipts)
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

type SmsStatus = "queued" | "sent" | "delivered" | "failed" | "undelivered";

/**
 * Normalize Mobivate's status string to our sms_messages_v2.status enum.
 * Anything we don't recognize is treated as 'failed' (safer than silently
 * leaving the row in 'sent' — stakeholders reviewing the table want to see
 * problems, not ambiguity).
 */
function normalizeStatus(raw: unknown): SmsStatus {
  if (typeof raw !== "string") return "failed";
  const s = raw.trim().toUpperCase();
  if (s === "DELIVERED" || s === "DELIVRD") return "delivered";
  if (s === "UNDELIVERED" || s === "UNDELIVERABLE") return "undelivered";
  if (s === "ACCEPTED" || s === "SENT" || s === "ENROUTE") return "sent";
  return "failed";
}

export async function POST(request: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = await request.json();
  } catch {
    console.warn("[mobivate/delivery-status] non-JSON body — ignoring");
    return NextResponse.json({ received: false, error: "invalid json" }, { status: 200 });
  }

  console.log("[mobivate/delivery-status] payload:", JSON.stringify(payload));

  const reference = typeof payload.reference === "string" ? payload.reference : null;
  const providerMessageId = typeof payload.id === "string" ? payload.id : null;
  const status = normalizeStatus(payload.status);
  const reason = typeof payload.reason === "string" ? payload.reason : null;

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
