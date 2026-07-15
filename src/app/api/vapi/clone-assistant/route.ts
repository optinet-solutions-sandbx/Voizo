/**
 * POST /api/vapi/clone-assistant
 *
 * Clone-per-campaign: creates a new Vapi assistant by copying the base
 * assistant's config and applying voice + prompt overrides. Each campaign
 * gets its own isolated assistant — no shared state, no race conditions.
 *
 * The clone-payload construction (~360 lines of runtime-policy + overrides)
 * was extracted into src/lib/vapi/cloneAssistant.ts as `createClone()` on
 * 2026-05-18 so the new rebind endpoint at /api/campaigns-v2/[id]/rebind
 * can share the same source of truth. This route is now a thin adapter:
 * env → body parse → createClone → SIP binding → response.
 *
 * Server-side only — VAPI_PRIVATE_KEY never leaves this handler.
 *
 * Request body:
 *   { baseAssistantId, voiceId?, systemPrompt?, campaignName }
 *
 * Returns:
 *   { assistantId, assistantName, sipUri, [poolSlotId], baseAssistantId, voiceId }
 *
 * baseAssistantId and voiceId are echoed from the request so the campaign-create
 * flow can persist them on the new campaigns_v2 row. The dashboard rebuild's
 * eject/re-bind primitive reads them to know which base + voice to re-clone with
 * on Resume. voiceId is null when the operator didn't pick one (clone falls back
 * to the base agent's default voice).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { leaseSlot, patchPhoneAssistant, releaseSlot } from "@/lib/vapi/sipPool";
import { createClone } from "@/lib/vapi/cloneAssistant";

export async function POST(request: NextRequest) {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "VAPI_PRIVATE_KEY is not set" },
      { status: 500 },
    );
  }

  const sipAuthPassword = process.env.VAPI_SIP_AUTH_PASSWORD;
  if (!sipAuthPassword) {
    return NextResponse.json(
      { error: "VAPI_SIP_AUTH_PASSWORD is not set" },
      { status: 500 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const baseAssistantId = body.baseAssistantId as string | undefined;
  const voiceId = body.voiceId as string | undefined;
  const systemPrompt = body.systemPrompt as string | undefined;
  const campaignName = body.campaignName as string | undefined;

  // VOZ-160: script-mode clone. Composes the prompt/config from scriptId and
  // clones the DESIGNATED script-base assistant (VAPI_SCRIPT_BASE_ASSISTANT_ID)
  // — the operator picked a Script, not an assistant. Everything downstream
  // (SIP binding, response) is identical to agent mode.
  const agentMode = body.agentMode as string | undefined;
  const scriptId = body.scriptId as string | undefined;

  // The base assistant actually cloned — echoed in the response so the campaign
  // row persists it (rebind/resume re-clone from base_assistant_id). For script
  // mode this is the designated script-base assistant, not an operator pick.
  let clonedFromBase = baseAssistantId ?? null;

  // Set when a per-campaign script copy is made below, so the response can echo
  // it (the campaign persists the COPY, not the operator's original).
  let campaignScript: { id: string; name: string } | null = null;

  let cloneResult;
  if (agentMode === "script") {
    if (!scriptId) {
      return NextResponse.json({ error: "scriptId required for script mode" }, { status: 400 });
    }
    const scriptBase = baseAssistantId || process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;
    clonedFromBase = scriptBase ?? null;
    if (!scriptBase) {
      return NextResponse.json(
        { error: "VAPI_SCRIPT_BASE_ASSISTANT_ID is not set (the base assistant to clone for script campaigns)" },
        { status: 500 },
      );
    }
    // ── Duplicate the script (VOZ-160) ──
    // Same isolation principle as the agent clone: the campaign runs a FROZEN
    // per-campaign copy of the script graph, so the operator can keep editing
    // the original in the Script Builder without disturbing a live campaign or
    // the original's pipeline. Deep-copies nodes + edges (fresh ids).
    const scriptName = body.scriptName as string | undefined;
    const { duplicateScript, deleteScript } = await import("@/lib/scriptEngine/lab-db");
    const copyName = `${scriptName ?? "Script"} — campaign: ${campaignName ?? "untitled"}`.slice(0, 200);
    let copy;
    try {
      copy = await duplicateScript(scriptId, copyName);
    } catch (e) {
      return NextResponse.json(
        { error: `Failed to duplicate script: ${e instanceof Error ? e.message : "unknown"}` },
        { status: 502 },
      );
    }
    campaignScript = { id: copy.id, name: copy.name };

    // Point the clone's webhook at the script-call route (derived from the
    // end-of-call default so preview deployments route correctly too).
    const eocUrl = process.env.VAPI_WEBHOOK_URL ?? "https://voizo-eight.vercel.app/api/webhooks/vapi/end-of-call";
    const serverUrl = eocUrl.replace(/\/end-of-call$/, "/script-call");
    const { composeScriptClone } = await import("@/lib/scriptEngine/composeAssistant");
    const persona = (body.persona as string | undefined) ?? systemPrompt;
    const scriptClone = await composeScriptClone({ scriptId: copy.id, persona });
    cloneResult = await createClone(key, scriptBase, { voiceId, campaignName, scriptClone, serverUrl });
    // Clone failed → the script copy is orphaned; best-effort remove it.
    if (!cloneResult.ok) {
      await deleteScript(copy.id).catch(() => {});
    }
  } else {
    // ── 1-3. Validate input + fetch base + build & POST clone (via helper) ──
    // The helper enforces the same input validation that used to live here
    // (baseAssistantId length, voiceId allowlist, systemPrompt length, voice
    // provider mismatch). Behavior is bit-exact with the pre-2026-05-18 route.
    cloneResult = await createClone(key, baseAssistantId ?? "", {
      voiceId,
      systemPrompt,
      campaignName,
    });
  }

  if (!cloneResult.ok) {
    return NextResponse.json(
      { error: cloneResult.error },
      { status: cloneResult.status },
    );
  }

  const clone = cloneResult.clone;

  // ── 4. Bind clone to a SIP route ──
  // Two paths gated by USE_SIP_POOL env flag:
  //   - true:  lease a pool slot, PATCH its assistantId
  //   - false: legacy per-campaign POST /phone-number
  // Path-by-flag at create time only. DELETE handler routes by data
  // (vapi_pool_slot_id presence on the campaign row) so flag flips
  // are safe under in-flight campaigns.
  const usePool = process.env.USE_SIP_POOL === "true";

  if (usePool) {
    // ── Pool path ──
    const slot = await leaseSlot(supabaseAdmin, clone.id);

    if (!slot) {
      // Pool exhausted. Roll back the clone (per legacy flow) and 503.
      console.warn("[clone-assistant] SIP pool exhausted; rolling back clone");
      await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      }).catch(() => {});
      return NextResponse.json(
        {
          error:
            "All SIP pool slots are in use. Wait for a running campaign to finish, " +
            "or contact admin to expand the pool.",
        },
        { status: 503 },
      );
    }

    // Slot leased. Now PATCH the Vapi phone to point at our clone.
    const patchRes = await patchPhoneAssistant(key, slot.vapi_phone_number_id, clone.id);

    if (!patchRes.ok) {
      // PATCH failed: release the slot (DB) and roll back the clone (Vapi).
      console.error("[clone-assistant] Vapi PATCH failed:", patchRes.body.slice(0, 500));
      await releaseSlot(supabaseAdmin, slot.id).catch(() => {});
      await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${key}` },
      }).catch(() => {});
      return NextResponse.json(
        { error: `Failed to bind SIP slot: ${patchRes.body.slice(0, 200)}` },
        { status: 502 },
      );
    }

    // Diagnostic log: pool utilization at lease time.
    console.log(
      `[clone-assistant] leased slot ${String(slot.slot_index).padStart(2, "0")} ` +
      `(${slot.sip_uri}) → assistant ${clone.id}`,
    );

    return NextResponse.json({
      assistantId: clone.id,
      assistantName: clone.name,
      sipUri: slot.sip_uri,
      poolSlotId: slot.id,
      baseAssistantId: clonedFromBase,
      voiceId: voiceId ?? null,
      ...(campaignScript ? { scriptId: campaignScript.id, scriptName: campaignScript.name } : {}),
    });
  }

  // ── Legacy path (per-campaign SIP creation) ──
  // Preserved bit-exact from the pre-pool code. Used when USE_SIP_POOL is
  // unset/false and during the dual-mode rollout window.
  // Option B (manifesto §8 Reliability): deterministic SIP routing, no webhook
  // in the call path. Each clone gets its own SIP endpoint on sip.vapi.ai.
  //
  // Note: we use clone.name (returned by Vapi) here rather than the locally-
  // computed cloneName. Vapi returns assistants with the name we sent unchanged;
  // if that ever stops being true, this name will drift from what Vapi shows
  // on the phone-number side. Verify via Vapi dashboard if the legacy path
  // is exercised.
  const sipUser = `voizo-campaign-${clone.id.slice(0, 8)}`;
  const sipUri = `sip:${sipUser}@sip.vapi.ai`;

  const phoneRes = await fetch("https://api.vapi.ai/phone-number", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      provider: "vapi",
      sipUri,
      assistantId: clone.id,
      name: clone.name,
      authentication: {
        username: sipUser,
        password: sipAuthPassword,
      },
    }),
  });

  if (!phoneRes.ok) {
    const errText = await phoneRes.text();
    console.error("Vapi SIP phone number creation failed:", errText.slice(0, 500));
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${key}` },
    }).catch(() => {});
    return NextResponse.json(
      { error: `Failed to create SIP phone number: ${errText.slice(0, 200)}` },
      { status: 502 },
    );
  }

  const phone = await phoneRes.json();

  return NextResponse.json({
    assistantId: clone.id,
    assistantName: clone.name,
    sipUri: phone.sipUri ?? sipUri,
    baseAssistantId: clonedFromBase,
    voiceId: voiceId ?? null,
    ...(campaignScript ? { scriptId: campaignScript.id, scriptName: campaignScript.name } : {}),
  });
}
