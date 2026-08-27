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
// smsDispatchDecision is pure (its only import is type-only), so the value
// import stays client-bundle-safe — client components already value-import it
// directly (modeHasLastResort in the campaign UIs).
import { modeHasLastResort, resolveSmsConsentMode, type SmsConsentMode } from "./smsDispatchDecision";

export type CallWindow = {
  day: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
  start: string;
  end: string;
};

export interface CampaignV2CreateInput {
  name: string;
  systemPrompt: string;
  // VOZ-160 (Script Engine). 'assistant' (default) = pick a Vapi assistant
  // (today's flow). 'script' = run a Script Engine flow; the clone is composed
  // from scriptId at launch. scriptId/scriptName only meaningful in script mode.
  agentMode?: "assistant" | "script";
  scriptId?: string | null;
  scriptName?: string | null;
  vapiAssistantId?: string; // Optional: recurring parents are created without a clone (no worker leased). Required for Fixed campaigns.
  vapiAssistantName?: string;
  vapiSipUri?: string;
  vapiPoolSlotId?: string; // SIP pool slot id when USE_SIP_POOL=true; null/undefined for legacy per-campaign flow
  baseAssistantId?: string; // Source agent the clone was made from; persisted for re-bind after eject
  voiceId?: string; // ElevenLabs voice ID chosen at create time; persisted for re-bind so operator intent survives eject. NULL = use base agent's default voice.
  segmentId?: number; // customer.io segment ID (single-segment imports only); persisted for Step 5 Duplicate, Step 6 Manual refresh, Step 7 Resume-diff. NULL for multi-segment imports.
  cioWorkspace?: string | null; // CIO workspace label (VOZ-198, e.g. "fortuneplay"). Must match a CUSTOMERIO_WEBHOOK_SIGNING_KEYS / CUSTOMERIO_APP_API_KEYS label. Absent/null = the default workspace (lucky7even). No wizard UI yet — workspace-2 campaigns are created via API.
  timezone: string;
  startAt?: string | null;
  endAt?: string | null;
  callWindows: CallWindow[];
  smsEnabled: boolean;
  smsTemplate?: string | null;
  smsOnGoalReachedOnly?: boolean;
  // Dispatch policy. verbal_yes = on-call yes required (default); registered_optin
  // = client-attested signup opt-in (2026-06-11); optin_any_pickup = same opt-in
  // basis, every answered line counts as reached (VOZ-245). Imported from the
  // decision module so this stays one union, not a copy that can drift.
  smsConsentMode?: SmsConsentMode;
  numbers: string[];
  /** E.164 → raw player name for the imported numbers (greet-by-name Ramp 1,
   *  2026-07-17). Optional + CIO-import-only; the insert applies it per final
   *  phone and clamps values server-side (client-supplied = trust boundary). */
  namesByPhone?: Record<string, string>;
  createdBy?: string | null;
  campaignType?: "fixed" | "recurring"; // Defaults to "fixed". Recurring parents save as status='running' with no clone; children are spawned by the scheduler.
  recurrencePattern?: RecurrencePattern | null; // Populated for campaignType='recurring'; null otherwise.
  isTest?: boolean; // Marks the campaign as a test run. Excluded from /api/audience/suggestions; operator-controllable in the wizard + detail page header.
  source?: string; // 'production' (default) | 'ghost_portal'. Segregates internal GhostPortal runs from client analytics/list.
  goalTarget?: number | null; // Optional target number of successful outcomes (e.g. deposits) for this campaign; rendered as X / Y in the performance report. Positive integer or null. Maps to campaigns_v2.goal_target.
  budgetUsd?: number | null; // Optional hard spend cap in USD (budget guardrail 2026-08-04): the scheduler auto-pauses the campaign when SUM(vapi_cost_usd + openai_cost_usd) reaches it. Positive number or null. Maps to campaigns_v2.budget_usd.
  voicemailAutohangup?: boolean; // Opt-in (2026-07-07): kill calls via Live Call Control when a final customer utterance is conclusively voicemail. Maps to campaigns_v2.voicemail_autohangup (default false). No wizard UI yet — trial campaigns set it via API/SQL.
  retryIntervalMinutes?: number; // Operator retry gap (VOZ-132 §7): 30 | 60 | 90. Absent/invalid → DB default 90.
  maxAttempts?: number; // Operator max tries per player: integer 2–5. Absent/invalid → DB default 3.
  dailyCap?: number | null; // Realtime cost brake: most players added per day. Positive integer; realtime campaigns only.
  realtime?: boolean; // Recurring parent in real-time top-up mode: children spawn empty, the per-minute poll fills them.
  smsLastResortTemplate?: string | null; // VOZ-132 §8, registered_optin only: non-empty → voicemails re-dial and this ONE text goes out after the final failed try. Null/absent → today's behavior. Maps to campaigns_v2.sms_last_resort_template.
  callDelayMinutes?: number | null; // Realtime: minutes between a sign-up appearing in the segment and the dial (1-1440). Null/absent = right away. Maps to campaigns_v2.call_delay_minutes.
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

/** Ceiling for the realtime call delay (24 hours). DB CHECK only enforces > 0
 *  (daily_cap precedent: DB floor, app whitelist). */
export const CALL_DELAY_MAX_MINUTES = 1440;

/**
 * Wizard/drawer "Call new sign-ups" pill + custom text -> minutes for the API.
 * null minutes = right away. invalid=true only for a bad CUSTOM value, so
 * callers can block save instead of silently sending "right away".
 */
export function resolveCallDelay(
  choice: string,
  customText: string,
): { minutes: number | null; invalid: boolean } {
  if (choice === "custom") {
    const t = customText.trim();
    const n = Number(t);
    const ok = t !== "" && Number.isInteger(n) && n > 0 && n <= CALL_DELAY_MAX_MINUTES;
    return ok ? { minutes: n, invalid: false } : { minutes: null, invalid: true };
  }
  if (choice === "5" || choice === "30" || choice === "60") {
    return { minutes: Number(choice), invalid: false };
  }
  return { minutes: null, invalid: false };
}

/**
 * Edit-page SMS consent keys of the settings PATCH body (2026-08-20 settings
 * consolidation — the always-on drawer's save semantics, moved here as a pure
 * tested function when the drawer folded into /campaigns/v2/[id]/edit).
 *
 *  - smsConsentMode only when CHANGED (VOZ-245): a no-op Save can't rewrite the
 *    column, and a legacy NULL (reads as verbal_yes) can't 400 the request.
 *  - smsLastResortTemplate: the toggle is the source of truth (VOZ-249) — off
 *    writes an explicit null, never an omitted key. Gated on the DRAFT's mode
 *    so a mode switch + text edit lands in one Save.
 *  - Leaving a last-resort mode clears any stored template: a stale "sorry we
 *    missed you" must not linger behind a mode whose UI can't show it. The
 *    sweep also mode-checks (decideLastResortSend), so this is hygiene on top
 *    of the gate, not the gate.
 */
export function buildSmsConsentPatch(args: {
  storedMode: unknown;
  storedLastResortTemplate: unknown;
  draftMode: SmsConsentMode;
  lastResortEnabled: boolean;
  lastResortText: string;
}): { smsConsentMode?: SmsConsentMode; smsLastResortTemplate?: string | null } {
  const patch: { smsConsentMode?: SmsConsentMode; smsLastResortTemplate?: string | null } = {};
  if (args.draftMode !== resolveSmsConsentMode(args.storedMode)) {
    patch.smsConsentMode = args.draftMode;
  }
  const storedTemplate =
    typeof args.storedLastResortTemplate === "string" ? args.storedLastResortTemplate.trim() : "";
  if (modeHasLastResort(args.draftMode)) {
    patch.smsLastResortTemplate = args.lastResortEnabled ? args.lastResortText.trim() || null : null;
  } else if (storedTemplate.length > 0) {
    patch.smsLastResortTemplate = null;
  }
  return patch;
}

/**
 * Operator-control inputs → DB column keys, as CONDITIONAL keys only
 * (voicemail_autohangup precedent): an absent/invalid input sends no key, so
 * DB defaults win and a deploy that precedes the realtime migration can never
 * reference a missing column. Whitelists mirror the wizard UI (30/60/90 gap,
 * 2–5 tries, call delay 1–1440) and the DB CHECK (daily_cap > 0).
 */
export function normalizeOperatorControls(
  i: Pick<
    CampaignV2CreateInput,
    "retryIntervalMinutes" | "maxAttempts" | "dailyCap" | "realtime" | "callDelayMinutes"
  >,
): Record<string, unknown> {
  return {
    ...([30, 60, 90].includes(i.retryIntervalMinutes as number)
      ? { retry_interval_minutes: i.retryIntervalMinutes }
      : {}),
    ...(Number.isInteger(i.maxAttempts) && (i.maxAttempts as number) >= 2 && (i.maxAttempts as number) <= 5
      ? { max_attempts: i.maxAttempts }
      : {}),
    ...(Number.isInteger(i.dailyCap) && (i.dailyCap as number) > 0 ? { daily_cap: i.dailyCap } : {}),
    ...(i.realtime === true ? { realtime: true } : {}),
    ...(Number.isInteger(i.callDelayMinutes) &&
    (i.callDelayMinutes as number) > 0 &&
    (i.callDelayMinutes as number) <= CALL_DELAY_MAX_MINUTES
      ? { call_delay_minutes: i.callDelayMinutes }
      : {}),
  };
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

/**
 * Join raw Customer.io {phone, name} entries to the E.164 keys the insert
 * pipeline stores (greet-by-name Ramp 1, 2026-07-17). Normalizes each phone
 * through parsePhoneList — the SAME canonicalization as the number inserts —
 * so map keys line up with campaign_numbers_v2.phone_e164. Nameless and
 * unparseable entries are skipped; the first name seen for a phone wins
 * (mirrors parsePhoneList's first-occurrence dedup).
 */
/**
 * Is this SMS text safe to store and send? Returns an operator-readable problem,
 * or null when the text is fine. Runs on the ASSEMBLED text (message + link +
 * footer), not on the link field alone, so a scheme pasted into the message body
 * is caught the same way.
 *
 * 2026-08-27: nine NZ templates went out as "https://https://Lucky-even.win/..."
 * — a full address pasted into a field that already read https://. 124 players
 * received a link that goes nowhere. The wizard's only check was startsWith
 * ("https://"), which that text passes, and the edit page had no check at all.
 * Called from every path that writes sms_template: the create route, the edit
 * page's PATCH, and the wizard (so the operator sees it at Step 4).
 */
export function smsTemplateProblem(text: string | null | undefined): string | null {
  if (!text) return null;
  if (/https?:\/\/\s*https?:\/\//i.test(text)) {
    return "The link has https:// twice (\"https://https://…\"). Players cannot open it. Paste the address once, without repeating https://.";
  }
  return null;
}

export function nameByE164(entries: Array<{ phone: string; name: string | null }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (!e.name) continue;
    const e164 = parsePhoneList(e.phone)[0];
    if (e164 && !map.has(e164)) map.set(e164, e.name);
  }
  return map;
}
