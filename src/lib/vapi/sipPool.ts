// SIP Pool helpers: lease, link, release.
//
// Built on three Postgres RPCs (see supabase-migration-sip-pool-rpc.sql)
// that bypass the slot table's RLS using SECURITY DEFINER. The RPCs are
// the only privileged code path; this module just calls them.
//
// Used by:
//   src/app/api/vapi/clone-assistant/route.ts  (POST handler — lease)
//   src/lib/campaignV2Data.ts                  (createCampaignV2 — link)
//   src/app/api/campaigns-v2/[id]/route.ts     (DELETE handler — release)
//
// Phase 1 step 5 of the SIP pool rollout. Gated by USE_SIP_POOL env flag
// in the call-path code; this module itself is flag-agnostic.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface SipPoolSlot {
  id: string;
  slot_index: number;
  sip_uri: string;
  sip_username: string;
  vapi_phone_number_id: string;
}

/**
 * Lease the lowest-numbered free slot atomically.
 *
 * Returns the slot row, or null if the pool is exhausted (all 5 leased).
 * The slot is bound to the assistant_id immediately; campaign_id stays
 * NULL until linkSlot() is called from the campaign-create flow.
 *
 * Uses SELECT ... FOR UPDATE SKIP LOCKED inside the RPC so concurrent
 * lease attempts never race for the same slot.
 */
export async function leaseSlot(
  supabase: SupabaseClient,
  assistantId: string,
): Promise<SipPoolSlot | null> {
  const { data, error } = await supabase.rpc("lease_vapi_sip_slot", {
    p_assistant_id: assistantId,
  });

  if (error) {
    throw new Error(`leaseSlot RPC failed: ${error.message}`);
  }

  // RPC returns SETOF; data is an array. Empty = pool exhausted.
  const rows = (data ?? []) as SipPoolSlot[];
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Back-link a freshly-created campaign to its already-leased slot.
 *
 * Refuses (returns false) if the slot is not currently leased to the
 * expected assistant — guards against cross-wiring under bug conditions.
 * Idempotent on success.
 */
export async function linkSlot(
  supabase: SupabaseClient,
  params: { slotId: string; campaignId: string; expectedAssistantId: string },
): Promise<boolean> {
  const { data, error } = await supabase.rpc("link_vapi_sip_slot", {
    p_slot_id: params.slotId,
    p_campaign_id: params.campaignId,
    p_expected_assistant_id: params.expectedAssistantId,
  });

  if (error) {
    throw new Error(`linkSlot RPC failed: ${error.message}`);
  }

  return data === true;
}

/**
 * Release a leased slot back to the pool.
 *
 * Idempotent: releasing an already-free slot returns false (no-op).
 * Releasing a leased slot clears assistant_id, campaign_id, sets
 * status='free', stamps released_at.
 *
 * NOTE: This only releases the DB row. The caller is responsible for
 * PATCH'ing the Vapi phone number with assistantId=null FIRST to detach
 * the clone from the SIP route before any in-flight call hits a
 * just-deleted assistant.
 */
export async function releaseSlot(
  supabase: SupabaseClient,
  slotId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("release_vapi_sip_slot", {
    p_slot_id: slotId,
  });

  if (error) {
    throw new Error(`releaseSlot RPC failed: ${error.message}`);
  }

  return data === true;
}

/**
 * PATCH a Vapi phone number's assistantId. Thin wrapper around the
 * Vapi REST API used by lease and release flows. Phase 0 verified
 * both `<id>` and `null` are accepted as values.
 *
 * Returns the response status; caller decides how to handle non-2xx.
 */
export async function patchPhoneAssistant(
  vapiPrivateKey: string,
  phoneNumberId: string,
  assistantId: string | null,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `https://api.vapi.ai/phone-number/${encodeURIComponent(phoneNumberId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${vapiPrivateKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ assistantId }),
    },
  );
  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/**
 * Ghost (production-priority) lease: only lease a slot when the number of FREE
 * slots EXCEEDS `reserve`, so internal GhostPortal runs never consume the
 * headroom client campaigns need. Returns 'reserved' (a yield — caller surfaces
 * "no capacity, retry") instead of a slot when the pool is at/below the floor.
 *
 * The small count→lease TOCTOU is acceptable for a yield: the scheduler starts
 * production drafts before ghost drafts, and the heartbeat reconciles. Does NOT
 * modify leaseSlot (a HIGH-blast-radius shared path) — it composes on top of it.
 */
export async function leaseSlotForGhost(
  supabase: SupabaseClient,
  assistantId: string,
  reserve: number,
): Promise<SipPoolSlot | null | "reserved"> {
  const { count, error } = await supabase
    .from("vapi_sip_pool")
    .select("id", { count: "exact", head: true })
    .eq("status", "free");
  if (error) {
    throw new Error(`leaseSlotForGhost free-count failed: ${error.message}`);
  }
  if ((count ?? 0) <= reserve) return "reserved";
  return leaseSlot(supabase, assistantId);
}
