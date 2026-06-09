import type { SupabaseClient } from "@supabase/supabase-js";
import { createClone } from "../vapi/cloneAssistant";
import { leaseSlotForGhost, patchPhoneAssistant, releaseSlot } from "../vapi/sipPool";
import { createCampaignV2 } from "../campaignV2Data";
import type { CallWindow } from "../campaignV2Shared";

// launchGhostRun — the Vapi/DB work of turning a prepared (DNC-scrubbed) GhostPortal
// run into a live campaign. Mirrors executeRebindCore (clone -> lease -> PATCH ->
// materialize) but uses leaseSlotForGhost (production-priority) and createCampaignV2
// with source='ghost_portal' instead of flipping an existing row to running.
//
// COST/COMPLIANCE: the clone inherits Voizo's cost guardrails via createClone
// (3-min cap, silence timeout, endphrases). `numbers` MUST already be DNC-scrubbed
// by the caller. Every failure path rolls back the clone + slot so a partial launch
// never orphans a billable Vapi clone or a leased SIP slot.

export interface GhostLaunchInput {
  supabase: SupabaseClient;
  vapiPrivateKey: string;
  reserve: number;
  run: { id: string; name: string; tier: "test" | "live"; base_assistant_id: string; operator: string };
  systemPrompt: string;
  timezone: string;
  callWindows: CallWindow[]; // [] for test (always-open); non-empty for live (validated upstream)
  numbers: string[]; // already DNC-scrubbed
  smsEnabled: boolean;
  smsTemplate: string | null;
}

export type GhostLaunchResult =
  | { ok: true; campaignId: string; slotIndex: number; numberCount: number }
  | { ok: false; status: number; error: string };

async function deleteClone(vapiPrivateKey: string, cloneId: string): Promise<void> {
  await fetch(`https://api.vapi.ai/assistant/${cloneId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${vapiPrivateKey}` },
  }).catch(() => {});
}

export async function launchGhostRun(input: GhostLaunchInput): Promise<GhostLaunchResult> {
  const { supabase, vapiPrivateKey, reserve, run } = input;

  // 1. Clone the base assistant (inherits Voizo cost/safety guardrails).
  const cloneResult = await createClone(vapiPrivateKey, run.base_assistant_id, {
    systemPrompt: input.systemPrompt || undefined,
    campaignName: run.name || undefined,
  });
  if (!cloneResult.ok) return { ok: false, status: cloneResult.status, error: cloneResult.error };
  const clone = cloneResult.clone;

  // 2. Production-priority lease. leaseSlotForGhost THROWS on a free-count or
  // leaseSlot RPC error — if it does, the clone above is already billable, so
  // delete it before propagating (never orphan a billable Vapi clone).
  let slot: Awaited<ReturnType<typeof leaseSlotForGhost>>;
  try {
    slot = await leaseSlotForGhost(supabase, clone.id, reserve);
  } catch (e) {
    await deleteClone(vapiPrivateKey, clone.id);
    return { ok: false, status: 500, error: `SIP lease failed: ${(e as Error).message}` };
  }
  if (slot === "reserved") {
    await deleteClone(vapiPrivateKey, clone.id);
    return {
      ok: false,
      status: 503,
      error: "No spare SIP capacity (production-priority reserve). Retry shortly.",
    };
  }
  if (!slot) {
    await deleteClone(vapiPrivateKey, clone.id);
    return { ok: false, status: 503, error: "All SIP pool slots are in use." };
  }

  // 3. Bind the slot's phone to the clone.
  const patchRes = await patchPhoneAssistant(vapiPrivateKey, slot.vapi_phone_number_id, clone.id);
  if (!patchRes.ok) {
    await releaseSlot(supabase, slot.id).catch(() => {});
    await deleteClone(vapiPrivateKey, clone.id);
    return { ok: false, status: 502, error: `Failed to bind SIP slot: ${patchRes.body.slice(0, 200)}` };
  }

  // 4. Materialize into campaigns_v2 (createCampaignV2 links the slot internally).
  try {
    const { campaign, numberCount } = await createCampaignV2({
      name: run.name,
      systemPrompt: input.systemPrompt,
      vapiAssistantId: clone.id,
      vapiAssistantName: clone.name,
      vapiSipUri: slot.sip_uri,
      vapiPoolSlotId: slot.id,
      baseAssistantId: run.base_assistant_id,
      timezone: input.timezone,
      startAt: new Date().toISOString(), // eligible immediately; the dialer still window-gates
      callWindows: input.callWindows,
      smsEnabled: input.smsEnabled,
      smsTemplate: input.smsTemplate,
      numbers: input.numbers,
      createdBy: run.operator,
      campaignType: "fixed",
      isTest: run.tier === "test",
      source: "ghost_portal",
    });
    return {
      ok: true,
      campaignId: campaign.id as string,
      slotIndex: slot.slot_index,
      numberCount,
    };
  } catch (e) {
    // Materialization failed AFTER lease+patch — roll back so nothing is orphaned.
    await patchPhoneAssistant(vapiPrivateKey, slot.vapi_phone_number_id, null).catch(() => {});
    await releaseSlot(supabase, slot.id).catch(() => {});
    await deleteClone(vapiPrivateKey, clone.id);
    return { ok: false, status: 500, error: `Campaign materialization failed: ${(e as Error).message}` };
  }
}
