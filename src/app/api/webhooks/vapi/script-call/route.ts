// POST /api/webhooks/vapi/script-call — VAPI webhook for SCRIPT-mode campaigns
// (VOZ-158). Auto-public under /api/webhooks/ (middleware PUBLIC_PATH_PREFIXES).
//
// Routing:
//   - end-of-call-report -> processEndOfCall (VOZ-157 shared lib) so every
//     downstream outcome/SMS/suppression path is IDENTICAL to agent-mode.
//   - transcript / speech-update / status-update / tool-calls -> the ported
//     Script Engine (VOZ-150 handleWebhook), which classifies, arms stages,
//     and drives the flow via the call's control URL.
//
// Auth: same x-vapi-secret constant-time check as end-of-call/route.ts.
//
// "Which script is this call running?" — the engine keys everything on
// lab_call_flow_state.script_id. For campaign calls we seed that per-call row
// from the campaign BEFORE the engine runs (the source app used a global
// lab_settings.active_script_id, which can't work when many campaigns run
// different scripts). Deterministic path: vapi_call_id -> calls_v2 ->
// campaign -> campaigns_v2.script_id. See resolveScriptForCall for the
// live-hardening caveat (calls_v2.vapi_call_id is matched late).
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { processEndOfCall } from "@/lib/webhooks/processEndOfCall";
import { handleWebhook, type VapiMessage } from "@/lib/scriptEngine/handleWebhook";

// The engine can hold the line a while (speaking lock + classification + inject).
export const maxDuration = 60;

/**
 * Ensure lab_call_flow_state.script_id is set for this call before the engine
 * runs, so it walks the campaign's script (not a global default).
 *
 * Deterministic path: vapi_call_id -> calls_v2.campaign_id ->
 * campaigns_v2.script_id. Idempotent: only seeds when the row is missing (the
 * engine owns the row from the first turn onward).
 *
 * LIVE-HARDENING CAVEAT (plan §2.4): calls_v2.vapi_call_id is matched LATE
 * (the SIP bridge doesn't know the VAPI call id at dial time), so mid-call
 * this lookup can miss. TODO(VOZ-160/live): stamp script_id at dial time, or
 * fall back to SIP-URI-suffix matching + "the one running script campaign on
 * that slot" (concurrency is per-slot sequential, so that's deterministic in
 * practice). Until then, a miss means the engine falls back to its own
 * lab_settings default — acceptable for the attended pilot, not for prod.
 */
async function resolveScriptForCall(vapiCallId: string): Promise<void> {
  try {
    const { data: existing } = await supabaseAdmin
      .from("lab_call_flow_state")
      .select("call_id, script_id")
      .eq("call_id", vapiCallId)
      .maybeSingle();
    if (existing?.script_id) return; // engine already knows this call's script

    const { data: call } = await supabaseAdmin
      .from("calls_v2")
      .select("campaign_id")
      .eq("vapi_call_id", vapiCallId)
      .maybeSingle();
    if (!call?.campaign_id) return; // late-matching miss — see caveat above

    const { data: camp } = await supabaseAdmin
      .from("campaigns_v2")
      .select("script_id")
      .eq("id", call.campaign_id)
      .maybeSingle();
    if (!camp?.script_id) return;

    await supabaseAdmin
      .from("lab_call_flow_state")
      .upsert({ call_id: vapiCallId, script_id: camp.script_id }, { onConflict: "call_id" });
  } catch (err) {
    // Never block the turn on resolution — the engine still runs.
    console.warn(`[script-call] script resolution failed for ${vapiCallId}:`, err);
  }
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── x-vapi-secret auth (identical to end-of-call/route.ts) ──
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET || process.env.VAPI_PRIVATE_KEY;
  const vapiSecretHeader = request.headers.get("x-vapi-secret");
  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error("FATAL: VAPI_WEBHOOK_SECRET not set — rejecting script-call webhook");
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }
    console.warn("script-call webhook: no webhook secret configured (accepting in dev only)");
  } else if (!vapiSecretHeader) {
    return NextResponse.json({ error: "Missing signature" }, { status: 403 });
  } else {
    const received = Buffer.from(vapiSecretHeader, "utf-8");
    const expected = Buffer.from(webhookSecret, "utf-8");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }
  }

  const message = (body.message ?? {}) as VapiMessage;
  const type = message.type;

  // end-of-call-report: reuse the shared agent-mode pipeline verbatim.
  if (type === "end-of-call-report") {
    return processEndOfCall(message as Record<string, unknown>);
  }

  // Engine-driven turns. Seed the per-call script first so the engine walks
  // this campaign's flow, then hand the message to the ported runtime.
  if (type === "transcript" || type === "speech-update" || type === "status-update" || type === "tool-calls") {
    const callId = message.call?.id;
    if (callId) await resolveScriptForCall(callId);
    return handleWebhook(message);
  }

  return NextResponse.json({ received: true });
}
