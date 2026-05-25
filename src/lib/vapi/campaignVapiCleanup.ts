// Shared Vapi-cleanup chain. Extracted from eject/route.ts and the
// campaigns-v2 DELETE handler where the identical logic was inlined.
//
// Sequence (preserved verbatim from eject/route.ts:95-208):
//   1. If pool-slot-bound:  PATCH phone null → on success release slot →
//                           on failure mark slot maintenance
//   2. If legacy-per-campaign-SIP: list Vapi phones → find by assistantId →
//                                  DELETE phone
//   3. Always: GET assistant → check metadata.voizoClone === true →
//              DELETE assistant (otherwise log + skip)
//
// The 2026-05-15 base-agent-safety guard (metadata.voizoClone check) is
// preserved verbatim. Without it, deleting an old paused campaign that
// references a base agent directly would nuke the base agent
// (real incident: lost "Ernie - Voice Agent" base on 2026-05-15).
//
// Used by:
//   src/app/api/campaigns-v2/[id]/eject/route.ts
//   src/app/api/campaigns-v2/[id]/route.ts        (DELETE handler)
//   src/app/api/campaigns-v2/[id]/stop/route.ts   (flag-gated, Phase 0)
//   src/app/api/cron/campaign-scheduler/route.ts  (flag-gated, Phase 0)
//   src/app/api/webhooks/freeswitch/voice-status/route.ts (flag-gated, Phase 0)
//
// Idempotent on null inputs: callers can pass null for vapiAssistantId or
// vapiPoolSlotId (e.g., recurring parents that never leased a slot) and
// the helper does nothing.

import type { SupabaseClient } from "@supabase/supabase-js";
import { patchPhoneAssistant, releaseSlot } from "@/lib/vapi/sipPool";

export interface VapiCleanupParams {
  vapiKey: string;
  campaignName: string;
  vapiAssistantId: string | null;
  vapiPoolSlotId: string | null;
}

export interface VapiCleanupResult {
  /** e.g. 'voizo-sip-pool-slot-03' if a pool slot was released, else null */
  slotReleased: string | null;
  /** Non-fatal messages for the response body / audit log */
  vapiWarnings: string[];
}

export async function performCampaignVapiCleanup(
  supabase: SupabaseClient,
  params: VapiCleanupParams,
): Promise<VapiCleanupResult> {
  const { vapiKey, campaignName, vapiAssistantId, vapiPoolSlotId } = params;
  const vapiWarnings: string[] = [];
  let slotReleased: string | null = null;

  // No Vapi key or no assistant → nothing to clean up. Safe early return
  // for callers like recurring parents that never leased anything.
  if (!vapiKey || !vapiAssistantId) {
    return { slotReleased, vapiWarnings };
  }

  if (vapiPoolSlotId) {
    // ── Pool path ──
    const { data: slot } = await supabase
      .from("vapi_sip_pool")
      .select("id, slot_index, vapi_phone_number_id")
      .eq("id", vapiPoolSlotId)
      .maybeSingle();

    if (slot) {
      // PATCH null FIRST (detach assistant from SIP route) so no in-flight
      // call hits a just-deleted assistant.
      const patch = await patchPhoneAssistant(vapiKey, slot.vapi_phone_number_id as string, null);
      if (!patch.ok) {
        vapiWarnings.push(`pool detach failed (${patch.status})`);
        // Detach failed → mark slot maintenance so it doesn't get auto-leased
        // again until operator clears it.
        await supabase
          .from("vapi_sip_pool")
          .update({
            status: "maintenance",
            notes: `cleanup detach failed @ ${new Date().toISOString()}: ${patch.body.slice(0, 200)}`,
          })
          .eq("id", slot.id as string);
      } else {
        const released = await releaseSlot(supabase, slot.id as string).catch((err: Error) => {
          vapiWarnings.push(`pool release failed: ${err.message}`);
          return false;
        });
        if (released) {
          slotReleased = `voizo-sip-pool-slot-${String(slot.slot_index).padStart(2, "0")}`;
        }
      }
    } else {
      vapiWarnings.push(`pool slot ${vapiPoolSlotId} not found in vapi_sip_pool`);
    }
  } else {
    // ── Legacy path (per-campaign SIP) ──
    // Preserved bit-exact from eject/route.ts lines 142-166.
    try {
      const phonesRes = await fetch("https://api.vapi.ai/phone-number", {
        headers: { Authorization: `Bearer ${vapiKey}`, Accept: "application/json" },
      });
      if (phonesRes.ok) {
        const phones = await phonesRes.json();
        const match = phones.find(
          (p: { assistantId?: string }) => p.assistantId === vapiAssistantId,
        );
        if (match?.id) {
          const delPhone = await fetch(`https://api.vapi.ai/phone-number/${match.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${vapiKey}` },
          });
          if (!delPhone.ok) {
            vapiWarnings.push(`phone cleanup failed (${delPhone.status})`);
          }
        }
      }
    } catch (err) {
      vapiWarnings.push(`phone lookup failed: ${(err as Error).message}`);
    }
  }

  // ── Common: delete the cloned assistant (with voizoClone safety guard) ──
  // 2026-05-15 base-agent-safety guard. GET assistant → require
  // metadata.voizoClone === true → only then DELETE. If guard fails:
  // log loudly, leave the (likely-base) assistant alive, accept the
  // orphan clone as the lesser evil.
  try {
    const inspectRes = await fetch(
      `https://api.vapi.ai/assistant/${vapiAssistantId}`,
      { headers: { Authorization: `Bearer ${vapiKey}` } },
    );
    if (inspectRes.status === 404) {
      // Already gone — nothing to do.
    } else if (!inspectRes.ok) {
      vapiWarnings.push(
        `assistant inspect failed (${inspectRes.status}); skipped delete for safety`,
      );
    } else {
      const assistant = await inspectRes.json();
      if (assistant.metadata?.voizoClone === true) {
        const delAssistant = await fetch(
          `https://api.vapi.ai/assistant/${vapiAssistantId}`,
          { method: "DELETE", headers: { Authorization: `Bearer ${vapiKey}` } },
        );
        if (!delAssistant.ok && delAssistant.status !== 404) {
          vapiWarnings.push(`assistant cleanup failed (${delAssistant.status})`);
        }
      } else {
        console.warn(
          `[campaignVapiCleanup] REFUSED to delete assistant ${vapiAssistantId} ` +
          `(name: "${assistant.name ?? "unknown"}", campaign: "${campaignName}") — ` +
          `metadata.voizoClone is not true. Possible base agent or pre-metadata clone. ` +
          `Manual Vapi cleanup needed if intentional.`,
        );
        vapiWarnings.push(`assistant not a voizoClone — skipped delete for safety`);
      }
    }
  } catch (err) {
    vapiWarnings.push(`assistant inspect/delete failed: ${(err as Error).message}`);
  }

  return { slotReleased, vapiWarnings };
}
