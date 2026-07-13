// Browser-side data access for Campaign V2 that goes through server /api routes
// (service role) instead of the public anon Supabase client.
//
// RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md). This is the client
// half of the pattern: client components import from here (fetch -> /api ->
// supabaseAdmin) instead of from campaignV2Data.ts (now server-only). Every
// function below mirrors the signature of its old campaignV2Data counterpart so
// callers change only their import line. Pure helpers + types live in
// campaignV2Shared.ts (no supabase) — import those from there, not from here.

import type { CampaignV2CreateInput } from "./campaignV2Shared";
import type { RecurrencePattern } from "./types/recurrence";

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

export interface CampaignAnalyticsBundle {
  numbers: Row[];
  calls: Row[];
  sms: Row[];
}

/**
 * Read the campaigns list via the auth-gated server route. Mirrors the old
 * fetchCampaignsV2 (full rows, newest-first). Throws on a non-2xx response so
 * the list page's try/catch surfaces the failure.
 */
export async function fetchCampaignsV2(): Promise<Row[]> {
  const res = await fetch(`/api/campaigns-v2`);
  if (!res.ok) {
    throw new Error(`Failed to load campaigns (${res.status})`);
  }
  const data = (await res.json()) as { campaigns?: Row[] };
  return data.campaigns ?? [];
}

/**
 * Read a single campaign's config row. Throws on a non-2xx response — including
 * 404, matching the old `.single()` not-found behaviour the detail page handles.
 */
export async function fetchCampaignV2(id: string): Promise<Row> {
  const res = await fetch(`/api/campaigns-v2/${id}`);
  if (!res.ok) {
    throw new Error(`Failed to load campaign (${res.status})`);
  }
  return (await res.json()) as Row;
}

/**
 * Read the campaigns-list aggregation bundle (numbers/calls/SMS) used by the
 * list page's analytics. Columns are PII-minimized SERVER-side (the route only
 * selects aggregation fields), so the wire payload never carries phone numbers,
 * transcripts, or SMS bodies. Each bucket defaults to [].
 */
export async function fetchCampaignAnalytics(): Promise<CampaignAnalyticsBundle> {
  const res = await fetch(`/api/campaigns-v2/analytics`);
  if (!res.ok) {
    throw new Error(`Failed to load campaign analytics (${res.status})`);
  }
  const data = (await res.json()) as Partial<CampaignAnalyticsBundle>;
  return {
    numbers: data.numbers ?? [],
    calls: data.calls ?? [],
    sms: data.sms ?? [],
  };
}

/**
 * Create a campaign. The Vapi clone (for Fixed campaigns) is created by the
 * wizard before this call; the input already carries the clone ids. Returns the
 * created row + number count (matches the old createCampaignV2 return). Throws
 * the server's error message on a non-2xx so the wizard shows it inline.
 */
export async function createCampaignV2(
  input: CampaignV2CreateInput,
): Promise<{ campaign: Row; numberCount: number }> {
  const res = await fetch(`/api/campaigns-v2`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to create campaign (${res.status})`);
  }
  return (await res.json()) as { campaign: Row; numberCount: number };
}

/**
 * Flip a campaign's status (pause/resume soft transitions). Returns the updated
 * row (matches the old updateCampaignV2Status return). Throws the server's error
 * message on a non-2xx.
 */
export async function updateCampaignV2Status(id: string, status: string): Promise<Row> {
  const res = await fetch(`/api/campaigns-v2/${id}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to update campaign status (${res.status})`);
  }
  return (await res.json()) as Row;
}

/**
 * PATCH a recurring/real-time PARENT's next-child settings (always-on section
 * drawer, 2026-07-10). Server whitelists values; children pick the new values
 * up at the next spawn. Throws the server's error message on a non-2xx.
 */
export async function patchCampaignSettings(
  id: string,
  settings: {
    retryIntervalMinutes?: number;
    maxAttempts?: number;
    dailyCap?: number | null;
    smsLastResortTemplate?: string | null;
    callDelayMinutes?: number | null;
    // Edit page + always-on drawer (2026-07-13). Server validates via
    // buildParentEditUpdate; timezone change is guarded against double-spawn.
    recurrencePattern?: RecurrencePattern;
    timezone?: string;
    segmentId?: number;
    goalTarget?: number | null;
    smsTemplate?: string | null;
  },
): Promise<Row> {
  const res = await fetch(`/api/campaigns-v2/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to update settings (${res.status})`);
  }
  return (await res.json()) as Row;
}
