// Neutral, supabase-free shared module for Campaign V2: the types + pure
// helpers that BOTH client components and server code need.
//
// RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md): campaignV2Data.ts
// becomes server-only (it imports the service-role admin client, which throws
// at module load in the browser). These types/helpers used to live there and
// are value-imported by client components (parsePhoneList in the wizard steps).
// Keeping them here — with NO supabase import — lets the client bundle use them
// without dragging the admin client in. Server code imports them from here too.

import type { RecurrencePattern } from "./types/recurrence";

export type CallWindow = {
  day: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
  start: string;
  end: string;
};

export interface CampaignV2CreateInput {
  name: string;
  systemPrompt: string;
  vapiAssistantId?: string; // Optional: recurring parents are created without a clone (no worker leased). Required for Fixed campaigns.
  vapiAssistantName?: string;
  vapiSipUri?: string;
  vapiPoolSlotId?: string; // SIP pool slot id when USE_SIP_POOL=true; null/undefined for legacy per-campaign flow
  baseAssistantId?: string; // Source agent the clone was made from; persisted for re-bind after eject
  voiceId?: string; // ElevenLabs voice ID chosen at create time; persisted for re-bind so operator intent survives eject. NULL = use base agent's default voice.
  segmentId?: number; // customer.io segment ID (single-segment imports only); persisted for Step 5 Duplicate, Step 6 Manual refresh, Step 7 Resume-diff. NULL for multi-segment imports.
  timezone: string;
  startAt?: string | null;
  endAt?: string | null;
  callWindows: CallWindow[];
  smsEnabled: boolean;
  smsTemplate?: string | null;
  smsOnGoalReachedOnly?: boolean;
  smsConsentMode?: "verbal_yes" | "registered_optin"; // Dispatch policy (2026-06-11): verbal_yes = on-call yes required (default); registered_optin = client-attested signup opt-in, send on agent announce.
  numbers: string[];
  createdBy?: string | null;
  campaignType?: "fixed" | "recurring"; // Defaults to "fixed". Recurring parents save as status='running' with no clone; children are spawned by the scheduler.
  recurrencePattern?: RecurrencePattern | null; // Populated for campaignType='recurring'; null otherwise.
  isTest?: boolean; // Marks the campaign as a test run. Excluded from /api/audience/suggestions; operator-controllable in the wizard + detail page header.
  source?: string; // 'production' (default) | 'ghost_portal'. Segregates internal GhostPortal runs from client analytics/list.
}

export function defaultCallWindows(): CallWindow[] {
  return [
    { day: "sun", start: "12:00", end: "20:00" },
    { day: "mon", start: "12:00", end: "20:00" },
    { day: "tue", start: "12:00", end: "17:00" },
    { day: "wed", start: "12:00", end: "17:00" },
    { day: "thu", start: "12:00", end: "17:00" },
    { day: "fri", start: "18:00", end: "20:00" },
    { day: "sat", start: "12:00", end: "20:00" },
  ];
}

export function formatDefaultCallWindowsJson(): string {
  return JSON.stringify(defaultCallWindows(), null, 2);
}

export function parsePhoneList(input: string): string[] {
  const items = input
    .split(/[\n,]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  const normalized = items
    .map((value) => value.replace(/[^\d+]/g, ""))
    .map((value) => (value.startsWith("+") ? value : `+${value.replace(/[^\d]/g, "")}`))
    .filter((value) => /^\+\d{8,15}$/.test(value));

  return Array.from(new Set(normalized));
}
