// Browser-side data access for Campaign V2 that goes through server /api routes
// (service role) instead of the public anon Supabase client.
//
// RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md) — vertical slice.
// This is the client half of the pattern: client components import from here
// (fetch -> /api -> supabaseAdmin) instead of from campaignV2Data.ts (anon).
// The full Phase A migrates the remaining browser reads/writes (campaign list,
// single-campaign read, create, status/pause) the same way; this slice covers
// the highest-PII path: the campaign-detail child bundle.

type Row = Record<string, unknown>;

export interface CampaignDetailBundle {
  numbers: Row[];
  calls: Row[];
  sms: Row[];
}

/**
 * Fetch the campaign-detail child bundle (numbers + calls + SMS) via the
 * auth-gated server route. Throws on a non-2xx response so the caller's
 * try/catch can surface the failure (matches the detail page's existing
 * refreshData error handling).
 */
export async function fetchCampaignDetailBundle(campaignId: string): Promise<CampaignDetailBundle> {
  const res = await fetch(`/api/campaigns-v2/${campaignId}/detail`);
  if (!res.ok) {
    throw new Error(`Failed to load campaign detail (${res.status})`);
  }
  const data = (await res.json()) as Partial<CampaignDetailBundle>;
  return {
    numbers: data.numbers ?? [],
    calls: data.calls ?? [],
    sms: data.sms ?? [],
  };
}
