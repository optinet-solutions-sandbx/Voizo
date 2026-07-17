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
import { decideScriptSeed, type CampaignScriptRow } from "@/lib/scriptEngine/resolveScript";
import { cleanFirstName } from "@/lib/playerName";
import { parsePhoneList } from "@/lib/campaignV2Shared";

// The engine can hold the line a while (speaking lock + classification + inject).
export const maxDuration = 60;

/**
 * Seed lab_call_flow_state.script_id for this call BEFORE the engine runs, so
 * it walks the campaign's script (not a global default). Resolution ladder
 * (spec: docs/superpowers/specs/2026-07-14-script-resolution-hardening-design.md):
 *
 *  0. row already seeded → return (the engine owns the row from turn 1)
 *  1. message.call.assistantId → campaigns_v2.vapi_assistant_id — available on
 *     the FIRST message of the call (same field the voicemail auto-hangup path
 *     reads in end-of-call/route.ts). No .limit(1): assistant ids can recur
 *     (pool rotations, legacy shared voizo-poc). decideScriptSeed dedups by
 *     DISTINCT script_id; genuine ambiguity falls through — a wrong seed here
 *     would be permanent, since leg 0 returns early on any seeded row.
 *  2. calls_v2.vapi_call_id → campaign → script_id — the exact key; matched
 *     LATE by the SIP bridge, so it can miss early turns (kept as backstop).
 *  3. loud miss log — the engine will fall back to lab_settings' default;
 *     that must be visible, never silent. Fires per turn until seeded
 *     (bounded by call length; acceptable pilot noise).
 *
 * NOTE (workstream C, done): the engine's engagement gate, tool guards,
 * classifier vocabulary and watchdog all resolve per-call now via
 * resolveCallScriptId (state.script_id ?? lab_settings.active_script_id) —
 * a seeded campaign call is fully self-contained; the global remains only as
 * the fallback for unseeded Builder test calls and ladder misses.
 */
/**
 * Greet-by-name Ramp 2 (2026-07-17): resolve the callee's spoken first name
 * for lab_call_flow_state.variables. Primary key = the campaign contact row
 * matching the call's customer number; backstop = the campaign's single
 * in_progress number (campaigns dial one number at a time — used only when
 * EXACTLY one row is mid-flight, since SIP caller-id may not carry the player).
 * Hygiene via cleanFirstName; any doubt → null → the nameless greeting.
 */
async function playerVariables(
  campaignId: string,
  customerNumber: string | null,
): Promise<Record<string, string> | null> {
  try {
    let displayName: string | null = null;
    // Normalize whatever Vapi/SIP reports ("61402294427", "sip:+61...", spaces)
    // to the same E.164 the rows store — an exact-string eq would silently miss
    // (review finding 2026-07-17). Unparseable → rely on the backstop below.
    const e164 = customerNumber ? (parsePhoneList(customerNumber)[0] ?? null) : null;
    if (e164) {
      const { data } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("display_name")
        .eq("campaign_id", campaignId)
        .eq("phone_e164", e164)
        .maybeSingle();
      displayName = (data?.display_name as string | null) ?? null;
    }
    if (!displayName) {
      const { data } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("display_name")
        .eq("campaign_id", campaignId)
        .eq("outcome", "in_progress")
        .limit(2);
      if (data && data.length === 1) displayName = (data[0].display_name as string | null) ?? null;
    }
    const playerName = cleanFirstName(displayName);
    return playerName ? { playerName } : null;
  } catch {
    return null; // never block the turn on a name
  }
}

async function resolveScriptForCall(
  vapiCallId: string,
  assistantId: string | null,
  customerNumber: string | null,
): Promise<void> {
  try {
    const { data: existing } = await supabaseAdmin
      .from("lab_call_flow_state")
      .select("call_id, script_id")
      .eq("call_id", vapiCallId)
      .maybeSingle();
    if (existing?.script_id) return; // engine already knows this call's script

    // ── Leg 1: assistantId → campaign (deterministic from the first message) ──
    if (assistantId) {
      const { data: camps } = await supabaseAdmin
        .from("campaigns_v2")
        .select("id, script_id, agent_mode")
        .eq("vapi_assistant_id", assistantId);
      const decision = decideScriptSeed((camps ?? []) as CampaignScriptRow[]);
      if (decision.kind === "seed") {
        const vars = await playerVariables(decision.campaignId, customerNumber);
        await supabaseAdmin
          .from("lab_call_flow_state")
          .upsert(
            { call_id: vapiCallId, script_id: decision.scriptId, ...(vars ? { variables: vars } : {}) },
            { onConflict: "call_id" },
          );
        await supabaseAdmin.from("lab_call_events").insert({
          call_id: vapiCallId,
          event_type: "status",
          content: "script resolved via assistantId",
          meta: { assistantId, campaignId: decision.campaignId, scriptId: decision.scriptId },
        });
        return;
      }
      if (decision.kind === "ambiguous") {
        await supabaseAdmin.from("lab_call_events").insert({
          call_id: vapiCallId,
          event_type: "error",
          content: `assistantId ambiguous — ${decision.campaignIds.length} campaigns, fell through`,
          meta: { assistantId, campaignIds: decision.campaignIds, scriptIds: decision.scriptIds },
        });
        // fall through to leg 2 (exact key) — never guess
      }
    }

    // ── Leg 2: exact key — vapi_call_id -> calls_v2 -> campaign (backstop) ──
    const { data: call } = await supabaseAdmin
      .from("calls_v2")
      .select("campaign_id, campaign_number_id")
      .eq("vapi_call_id", vapiCallId)
      .maybeSingle();
    if (call?.campaign_id) {
      const { data: camp } = await supabaseAdmin
        .from("campaigns_v2")
        .select("script_id")
        .eq("id", call.campaign_id)
        .maybeSingle();
      if (camp?.script_id) {
        // Exact contact row in hand → precise name, no backstop guessing.
        let vars: Record<string, string> | null = null;
        if (call.campaign_number_id) {
          const { data: num } = await supabaseAdmin
            .from("campaign_numbers_v2")
            .select("display_name")
            .eq("id", call.campaign_number_id)
            .maybeSingle();
          const playerName = cleanFirstName((num?.display_name as string | null) ?? null);
          if (playerName) vars = { playerName };
        }
        await supabaseAdmin
          .from("lab_call_flow_state")
          .upsert(
            { call_id: vapiCallId, script_id: camp.script_id, ...(vars ? { variables: vars } : {}) },
            { onConflict: "call_id" },
          );
        return;
      }
    }

    // ── Leg 3: loud miss — fallback usage must be visible, never silent ──
    await supabaseAdmin.from("lab_call_events").insert({
      call_id: vapiCallId,
      event_type: "error",
      content: "script resolution missed — engine will use lab default",
      meta: { assistantId },
    });
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
    if (callId) {
      // Customer number rides the RAW payload (the shared VapiMessage type
      // doesn't model it) — used to key the greet-by-name variables seed.
      const rawCall = (body.message as Record<string, unknown> | undefined)?.call as
        | Record<string, unknown>
        | undefined;
      const customer = rawCall?.customer as Record<string, unknown> | undefined;
      const customerNumber = typeof customer?.number === "string" ? customer.number : null;
      await resolveScriptForCall(callId, message.call?.assistantId ?? null, customerNumber);
    }
    return handleWebhook(message);
  }

  return NextResponse.json({ received: true });
}
