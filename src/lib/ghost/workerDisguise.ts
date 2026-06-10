// Presentation-only disguise for the Workers tab. A SIP slot leased to an
// internal GhostPortal campaign (source='ghost_portal') is shown as
// "maintenance" with every lease detail stripped (no ghost campaign name,
// assistant, in-flight call, or timing) — so a ghost run never reveals itself
// in the Workers view.
//
// IMPORTANT: this rewrites only the API RESPONSE. The DB vapi_sip_pool.status
// stays 'leased', so the SIP reserve floor, concurrency gate, and eject pipeline
// are all unaffected. The Workers UI already renders a "maintenance" slot (red /
// wrench, no campaign detail, no eject button).

export const GHOST_MAINTENANCE = "maintenance";

export interface WorkerSlotResponse {
  slotIndex: number;
  slotLabel: string;
  status: string;
  sipUri: string;
  leasedAt: string | null;
  leasedDurationMs: number | null;
  campaign: unknown | null;
  inFlightCall: unknown | null;
  notes: string | null;
}

/**
 * If the slot is leased to a ghost campaign, return a maintenance-disguised copy;
 * otherwise return the slot unchanged. `leasedCampaignSource` is the `source` of
 * the campaign currently leasing the slot (null/undefined for free/legacy slots).
 */
export function disguiseIfGhost<T extends WorkerSlotResponse>(
  slot: T,
  leasedCampaignSource: string | null | undefined,
): T {
  if (leasedCampaignSource !== "ghost_portal") return slot;
  return {
    ...slot,
    status: GHOST_MAINTENANCE,
    leasedAt: null,
    leasedDurationMs: null,
    campaign: null,
    inFlightCall: null,
    notes: null,
  };
}
