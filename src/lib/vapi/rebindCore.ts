/**
 * executeRebindCore — the Vapi/DB work of taking a `paused` or `inactive`
 * campaign back to `running`. Reusable across:
 *   - POST /api/campaigns-v2/[id]/rebind         (Step 4b — direct operator
 *                                                  rebind without diff;
 *                                                  inactive only in practice)
 *   - POST /api/campaigns-v2/[id]/resume         (Step 7 — operator resume
 *                                                  with three-bucket diff;
 *                                                  Phase 4 of the SIP-slot
 *                                                  release design unified
 *                                                  both paused and inactive
 *                                                  resumes onto this path)
 *
 * The helper assumes the caller has already:
 *   - Performed the origin/CSRF check
 *   - Validated the campaign row exists and status IN ('paused', 'inactive')
 *   - For "old-shape paused" (pre-Phase-4 data where vapi_pool_slot_id is
 *     non-null), the caller has already run performCampaignVapiCleanup to
 *     release the stale slot and delete the stale clone (§6.6 of the design
 *     doc). Otherwise this helper will lease a SECOND slot, orphaning the
 *     first.
 *   - Confirmed campaign.base_assistant_id is non-null
 *   - Loaded the VAPI_PRIVATE_KEY from env
 *
 * What it does:
 *   1. createClone(base, voice, prompt) using the preserved per-campaign values
 *   2. leaseSlot — on failure (pool exhausted) rolls back the clone, returns 503
 *   3. patchPhoneAssistant — on failure rolls back slot + clone, returns 502
 *   4. linkSlot — best-effort back-link; failure logs a warning, continues
 *   5. Atomic UPDATE campaigns_v2 SET vapi_assistant_id, vapi_pool_slot_id,
 *      vapi_sip_uri, status='running', last_resumed_at=now() WHERE id=$
 *      AND status IN ('paused','inactive') — race-guarded; 409 if 0 rows match
 *
 * Returns a discriminated union so callers can translate to NextResponse with
 * the appropriate HTTP status and shape.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClone } from "@/lib/vapi/cloneAssistant";
import { leaseSlot, linkSlot, patchPhoneAssistant, releaseSlot } from "@/lib/vapi/sipPool";
import { snapshotCampaignPrompt } from "@/lib/promptVersionData";

export interface RebindCoreCampaign {
  id: string;
  name: string;
  base_assistant_id: string;
  voice_id: string | null;
  system_prompt: string;
}

export interface RebindCoreSuccess {
  ok: true;
  clone: { id: string; name: string };
  slot: {
    id: string;
    slot_index: number;
    sip_uri: string;
    vapi_phone_number_id: string;
  };
  leasedAt: string;
  linkWarning?: string;
}

export interface RebindCoreFailure {
  ok: false;
  status: number;
  error: string;
}

export type RebindCoreResult = RebindCoreSuccess | RebindCoreFailure;

export async function executeRebindCore(
  supabase: SupabaseClient,
  vapiPrivateKey: string,
  campaign: RebindCoreCampaign,
): Promise<RebindCoreResult> {
  // ── 1. Re-clone via shared helper ──
  // voice_id NULL on the row → undefined override → clone inherits base.voice
  // (same fallback as create flow when operator skips the voice picker).
  const cloneResult = await createClone(vapiPrivateKey, campaign.base_assistant_id, {
    voiceId: campaign.voice_id ?? undefined,
    systemPrompt: campaign.system_prompt ?? undefined,
    campaignName: campaign.name ?? undefined,
  });

  if (!cloneResult.ok) {
    return { ok: false, status: cloneResult.status, error: cloneResult.error };
  }

  const clone = cloneResult.clone;

  // ── 2. Lease a slot ──
  const slot = await leaseSlot(supabase, clone.id);

  if (!slot) {
    // Pool exhausted. Roll back the clone.
    console.warn(`[rebindCore] SIP pool exhausted; rolling back clone ${clone.id}`);
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiPrivateKey}` },
    }).catch(() => {});
    return {
      ok: false,
      status: 503,
      error:
        "All SIP pool slots are in use. Eject a running campaign first, or wait for one to complete.",
    };
  }

  // ── 3. PATCH slot's phone to point at the new clone ──
  const patchRes = await patchPhoneAssistant(vapiPrivateKey, slot.vapi_phone_number_id, clone.id);
  if (!patchRes.ok) {
    console.error(`[rebindCore] Vapi PATCH failed:`, patchRes.body.slice(0, 500));
    await releaseSlot(supabase, slot.id).catch(() => {});
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiPrivateKey}` },
    }).catch(() => {});
    return {
      ok: false,
      status: 502,
      error: `Failed to bind SIP slot: ${patchRes.body.slice(0, 200)}`,
    };
  }

  // ── 4. Back-link slot → campaign (best-effort) ──
  let linkWarning: string | undefined;
  const linked = await linkSlot(supabase, {
    slotId: slot.id,
    campaignId: campaign.id,
    expectedAssistantId: clone.id,
  });
  if (!linked) {
    linkWarning = `linkSlot returned false for slot ${slot.id} (campaign ${campaign.id}, assistant ${clone.id}). Heartbeat will reconcile.`;
    console.warn(`[rebindCore] ${linkWarning}`);
  }

  // ── 5. Atomic terminal status flip ──
  // .in("status", ["paused", "inactive"]) guards against an unexpected
  // concurrent state change. Allows both pause and inactive as resume-source
  // states (Phase 4 of the SIP-slot release design unified them). If 0 rows
  // match, the new clone + slot are live on Vapi but the DB row didn't flip
  // — operator can run Eject again to reconcile (eject is idempotent in
  // that state: clone GET → 404 silently, slot release returns false
  // silently, UPDATE succeeds on whatever row state moved on).
  const leasedAt = new Date().toISOString();
  const { data: updated, error: updateErr } = await supabase
    .from("campaigns_v2")
    .update({
      vapi_assistant_id: clone.id,
      vapi_pool_slot_id: slot.id,
      vapi_sip_uri: slot.sip_uri,
      status: "running",
      last_resumed_at: leasedAt,
    })
    .eq("id", campaign.id)
    .in("status", ["paused", "inactive"])
    .select("id")
    .single();

  if (updateErr || !updated) {
    console.error(
      `[rebindCore] status flip lost the race for ${campaign.id}:`,
      updateErr,
    );
    return {
      ok: false,
      status: 409,
      error:
        "Campaign status changed during resume (someone else acted on this campaign). " +
        "The new clone and slot are live on Vapi. Eject the campaign and try again to reconcile.",
    };
  }

  // ── 6. Best-effort prompt-version snapshot (slice 2 — eval-loop keystone) ──
  // A re-clone can carry a changed prompt; capture the new effective prompt now
  // that the row points at the new clone. Awaited (serverless may freeze after
  // the response) but snapshotCampaignPrompt never throws, so it cannot turn a
  // successful rebind into a failure.
  await snapshotCampaignPrompt(campaign.id, clone.id);

  // ── 7. Best-effort voicemail-autohangup config on the NEW clone ──
  // A rebound campaign gets a fresh clone; if the campaign opted in, re-ensure
  // transcript streaming + controlUrl on it. Separate guarded read (NOT added to
  // the step-5 .select) so a missing voicemail_autohangup column — code deployed
  // before the migration — degrades to "skip" instead of failing the rebind.
  // ensureVoicemailAutohangupConfig itself never throws.
  try {
    const { data: flagRow } = await supabase
      .from("campaigns_v2")
      .select("voicemail_autohangup")
      .eq("id", campaign.id)
      .single();
    if (flagRow?.voicemail_autohangup === true) {
      const { ensureVoicemailAutohangupConfig } = await import("./liveCallControl");
      const cfg = await ensureVoicemailAutohangupConfig(vapiPrivateKey, clone.id);
      console.log(
        `[rebindCore] voicemail-autohangup config for ${clone.id}: ` +
          `ok=${cfg.ok} patched=${cfg.patched}${cfg.detail ? ` detail=${cfg.detail}` : ""}`,
      );
    }
  } catch (err) {
    console.warn("[rebindCore] voicemail-autohangup flag read skipped:", err);
  }

  return {
    ok: true,
    clone: { id: clone.id, name: clone.name },
    slot: {
      id: slot.id,
      slot_index: slot.slot_index,
      sip_uri: slot.sip_uri,
      vapi_phone_number_id: slot.vapi_phone_number_id,
    },
    leasedAt,
    ...(linkWarning ? { linkWarning } : {}),
  };
}
