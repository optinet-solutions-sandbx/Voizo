// src/app/campaigns/v2/new/wizardState.ts
//
// Single source of truth for the 5-step Campaign Create wizard.
// All form fields live here; step components dispatch fat actions
// (one per logical section) to update slices of state.
//
// Per the wizard port plan (Slice 1): only navigation actions are wired
// in this slice. Field-setting actions (SET_AUDIENCE_FIELDS,
// SET_AGENT_FIELDS, SET_SCHEDULE_FIELDS, SET_SMS_FIELDS,
// SET_RECURRENCE_PATTERN, IMPORT_SEGMENT, SUBMIT_START, SUBMIT_ERROR)
// land slice-by-slice in Slices 2-6. The full state shape is declared
// up-front so we don't refactor the type as we go.

import type { RecurrencePattern } from "@/lib/types/recurrence";
import { defaultRecurrencePattern } from "@/components/RecurrenceEditor";
import { parsePhoneList, type CallWindow, type CampaignV2CreateInput } from "@/lib/campaignV2Data";
import { allowedTimezonesForCountry, detectAudienceCountry } from "@/lib/audienceCountry";
import { dayOfWeekInTimezone } from "@/lib/dayOfWeekInTimezone";

export type Step = 1 | 2 | 3 | 4 | 5;

export type Day = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export const DAYS: ReadonlyArray<{ key: Day; label: string; short: string }> = [
  { key: "sun", label: "Sunday",    short: "SUN" },
  { key: "mon", label: "Monday",    short: "MON" },
  { key: "tue", label: "Tuesday",   short: "TUE" },
  { key: "wed", label: "Wednesday", short: "WED" },
  { key: "thu", label: "Thursday",  short: "THU" },
  { key: "fri", label: "Friday",    short: "FRI" },
  { key: "sat", label: "Saturday",  short: "SAT" },
];

export interface ScheduleRow {
  day: Day;
  enabled: boolean;
  start: string; // "HH:MM" 24-hour
  end: string;   // "HH:MM" 24-hour
}

export type StartMode = "now" | "delay" | "scheduled";

/**
 * Legal calling windows per timezone — ported verbatim from the classic
 * form at page-classic.tsx:144-162. Source of truth for the calling-hours
 * cascade fired by SET_AUDIENCE_FIELDS when `timezone` changes.
 *
 * If a timezone isn't in this table, getCallingHours() returns the safe
 * default (09:00-20:00).
 */
export const CALLING_HOURS: Record<string, { start: string; end: string; note: string }> = {
  "America/Toronto":     { start: "09:00", end: "21:00", note: "CRTC: 9am–9:30pm" },
  "America/New_York":    { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm (conservative)" },
  "America/Chicago":     { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm" },
  "America/Denver":      { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm" },
  "America/Los_Angeles": { start: "09:00", end: "21:00", note: "TCPA/FCC: 8am–9pm" },
  "America/Vancouver":   { start: "09:00", end: "21:00", note: "CRTC: 9am–9:30pm" },
  "America/Mexico_City": { start: "09:00", end: "20:00", note: "PROFECO guidance" },
  "Europe/London":       { start: "08:00", end: "21:00", note: "Ofcom/ICO: 8am–9pm" },
  "Europe/Athens":       { start: "09:00", end: "21:00", note: "EETT guidance" },
  "Europe/Paris":        { start: "09:00", end: "20:00", note: "Bloctel: 9am–8pm" },
  "Europe/Berlin":       { start: "09:00", end: "20:00", note: "UWG: 8am–9pm (conservative)" },
  "Europe/Madrid":       { start: "09:00", end: "21:00", note: "CNMC: 9am–9pm" },
  "Asia/Manila":         { start: "09:00", end: "20:00", note: "NTC guidance" },
  "Asia/Singapore":      { start: "09:00", end: "20:00", note: "PDPA guidance" },
  "Asia/Tokyo":          { start: "09:00", end: "20:00", note: "TCA guidance" },
  "Asia/Dubai":          { start: "09:00", end: "21:00", note: "TRA guidance" },
  "Australia/Sydney":    { start: "09:00", end: "20:00", note: "Do Not Call Register Act: 9am–8pm wkday, 9am–5pm Sat" },
  "UTC":                 { start: "09:00", end: "20:00", note: "Safe default" },
};

export function getCallingHours(tz: string) {
  return CALLING_HOURS[tz] ?? { start: "09:00", end: "20:00", note: "Safe default" };
}

export interface TimezoneOption { value: string; label: string; group: string; }

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: "America/Toronto",     label: "Toronto · EST",          group: "Americas" },
  { value: "America/New_York",    label: "New York · EST",         group: "Americas" },
  { value: "America/Chicago",     label: "Chicago · CST",          group: "Americas" },
  { value: "America/Denver",      label: "Denver · MST",           group: "Americas" },
  { value: "America/Los_Angeles", label: "Los Angeles · PST",      group: "Americas" },
  { value: "America/Vancouver",   label: "Vancouver · PST",        group: "Americas" },
  { value: "America/Mexico_City", label: "Mexico City · CST",      group: "Americas" },
  { value: "Europe/London",       label: "London · GMT/BST",       group: "Europe" },
  { value: "Europe/Paris",        label: "Paris · CET",            group: "Europe" },
  { value: "Europe/Berlin",       label: "Berlin · CET",           group: "Europe" },
  { value: "Europe/Madrid",       label: "Madrid · CET",           group: "Europe" },
  { value: "Europe/Athens",       label: "Athens · EET",           group: "Europe" },
  { value: "Asia/Dubai",          label: "Dubai · GST",            group: "Asia / Pacific" },
  { value: "Asia/Singapore",      label: "Singapore · SGT",        group: "Asia / Pacific" },
  { value: "Asia/Manila",         label: "Manila · PHT",           group: "Asia / Pacific" },
  { value: "Asia/Tokyo",          label: "Tokyo · JST",            group: "Asia / Pacific" },
  { value: "Australia/Sydney",    label: "Sydney · AEST",          group: "Asia / Pacific" },
  { value: "UTC",                 label: "UTC",                    group: "Other" },
];

// 2026-05-22: Three-source discriminator for Step 1's source picker tab strip.
// Replaces the binary manualPasteMode field. Each source has its own phone
// cache (cioPhones / voizoPhones / manualPhones) so flipping tabs preserves
// operator work. The active source's cache mirrors into numbersText, which
// remains the single source of truth for downstream consumers.
export type AudienceSource = "cio" | "voizo" | "manual";

export interface WizardState {
  step: Step;

  // Step 1 — Audience
  name: string;
  timezone: string;
  timezoneTouched: boolean;        // R6: prevents auto-tz from clobbering manual edits
  numbersText: string;             // Derived: mirrors the active source's phone cache. Operator-facing single source of truth for downstream consumers (buildCreateInput etc.).
  audienceSource: AudienceSource;  // 2026-05-22 — replaces manualPasteMode
  cioPhones: string;               // CIO source cache (newline-joined)
  voizoSegmentId: string | null;   // local_segments UUID (Voizo source)
  voizoSegmentName: string | null; // Voizo segment display name
  voizoPhones: string;             // Voizo source cache (newline-joined)
  manualPhones: string;            // Manual paste source cache (operator's textarea content)
  segmentId: number | null;
  segmentName: string | null;
  isTest: boolean;                 // Marks the campaign as a test; excludes from /audience suggestions. Defaults false.

  // Step 2 — Agent
  vapiAssistantId: string;
  baseVoiceId: string | null;      // read-only display; voice lock per R3
  voiceId: string;                 // R3: always "" in classic; never set by any UI; kept to make `voiceId || undefined` math identical in buildCloneRequest
  systemPrompt: string;

  // Step 3 — Schedule (Run-once branch)
  campaignType: "fixed" | "recurring";
  scheduleRows: ScheduleRow[];
  startMode: StartMode;
  delayMinutes: number;
  scheduledDate: string;           // R2: keep as string, never Date | null

  // Step 3 — Schedule (Repeat branch)
  recurrencePattern: RecurrencePattern;
  recurrenceErrors: string[];

  // Step 4 — Follow-up SMS
  smsEnabled: boolean;
  smsMessage: string;
  smsLink: string;
  smsOptout: string;
  smsLinkEditing: boolean;
  smsOptoutEditing: boolean;

  // Submit state
  saving: boolean;
  error: string | null;
}

/**
 * Slice-2 audience fields. Mirrors the classic form's setName / setTimezone /
 * setNumbersText / setSegmentId / setSegmentName / phoneEditing setters but
 * collapsed into a single fat action — see Plan-agent recommendation.
 *
 * If `timezone` is in the payload, the reducer ALSO cascades scheduleRows to
 * the new calling window (per classic page-classic.tsx:298-303) and flips
 * `timezoneTouched = true` so the auto-detect won't clobber it later (R6).
 */
export type AudiencePayload = Partial<
  Pick<WizardState, "name" | "timezone" | "numbersText" | "audienceSource" | "segmentId" | "segmentName" | "voizoSegmentId" | "voizoSegmentName" | "cioPhones" | "voizoPhones" | "manualPhones" | "isTest">
>;

/** Atomic segment-import update — phones + segmentId + segmentName arrive together. */
export interface ImportSegmentPayload {
  phones: string[];
  segmentId: number | null;
  segmentName: string | null;
}

/**
 * Slice-3 agent fields. When an assistant is picked, StepAgent dispatches
 * all three at once so the voice-lock + prompt-inherit happens atomically.
 * R3: never set `voiceId` here. `baseVoiceId` is for display only; the
 * clone request relies on its undefined-ness to inherit from base.
 */
export type AgentPayload = Partial<
  Pick<WizardState, "vapiAssistantId" | "baseVoiceId" | "systemPrompt">
>;

/**
 * Slice-4 schedule fields. Caller computes new scheduleRows when toggling
 * a day or editing a per-day time — the reducer simply spreads. Keeps the
 * action surface small while still allowing fine-grained updates.
 */
export type SchedulePayload = Partial<
  Pick<WizardState, "campaignType" | "scheduleRows" | "startMode" | "delayMinutes" | "scheduledDate">
>;

/**
 * Slice-5 SMS fields. Plus the edit-gate flags `smsLinkEditing` /
 * `smsOptoutEditing` — toggled true ONLY after a `window.confirm` gate
 * fires (compliance: changing the URL or opt-out wording is a regulated
 * action). Reducer just spreads; the confirm() lives in the step component.
 */
export type SmsPayload = Partial<
  Pick<
    WizardState,
    "smsEnabled" | "smsMessage" | "smsLink" | "smsOptout" | "smsLinkEditing" | "smsOptoutEditing"
  >
>;

/** Slice-5 recurrence update — pattern always, errors when validated. */
export interface RecurrencePatternPayload {
  pattern: RecurrencePattern;
  errors?: string[];
}

export type WizardAction =
  | { type: "GOTO_STEP"; step: Step }
  | { type: "NEXT" }
  | { type: "BACK" }
  | { type: "SET_AUDIENCE_FIELDS"; payload: AudiencePayload }
  | { type: "IMPORT_SEGMENT"; payload: ImportSegmentPayload }
  | { type: "SET_AGENT_FIELDS"; payload: AgentPayload }
  | { type: "SET_SCHEDULE_FIELDS"; payload: SchedulePayload }
  | { type: "SET_SMS_FIELDS"; payload: SmsPayload }
  | { type: "SET_RECURRENCE_PATTERN"; payload: RecurrencePatternPayload }
  | { type: "SUBMIT_START" }
  | { type: "SUBMIT_ERROR"; error: string };

/**
 * SMS defaults — ported verbatim from page-classic.tsx:17-24 (Lucky7even
 * Canada, approved by Maria, provided by Ernie 2026-04-22). TODO: per-brand
 * defaults when multi-brand Campaign V2 lands (handoff 2026-04-21 item #11).
 */
export const DEFAULT_SMS_MESSAGE =
  "Your 20 totally FREE spins await! Deposit $30 with code LUCKY for 300% bonus up to $500. Ends midnight.";
export const DEFAULT_SMS_LINK = "https://playmojo.live/promotions?fast-deposit=modal&bonus=LUCKY";
export const SMS_OPTOUT_FOOTER = "STOP? Qwt5.me";
/** Mobivate shortens every URL to cllk.me/xxxxxx — 22 chars. */
export const SHORTENED_URL_LENGTH = 22;

/** GSM-7 segment count: 1st segment fits 160 chars, multi-part uses 153 per segment. */
export function smsSegmentCount(len: number): number {
  if (len === 0) return 0;
  if (len <= 160) return 1;
  return Math.ceil(len / 153);
}

const DEFAULT_TZ = "America/Toronto";

function initialScheduleRows(start: string, end: string): ScheduleRow[] {
  return DAYS.map(({ key }) => ({ day: key, enabled: false, start, end }));
}

/**
 * Convert a source campaign's `call_windows` array into the wizard's
 * `scheduleRows` shape (all 7 days with an `enabled` flag).
 *
 * For each day present in `call_windows`: enabled=true with the saved start/end.
 * For days NOT in `call_windows`: enabled=false with the timezone's default
 * calling window as placeholder hours (consistent with createInitialState).
 *
 * Used by the Duplicate-via-Wizard prefill at WizardPage mount.
 */
export function deriveScheduleRows(
  callWindows: ReadonlyArray<{ day: string; start: string; end: string }> | null | undefined,
  timezone: string,
): ScheduleRow[] {
  const defaults = getCallingHours(timezone);
  const byDay = new Map<string, { start: string; end: string }>();
  for (const cw of callWindows ?? []) {
    // Defensive normalization (audit M3): V1 source campaigns may store
    // "Monday" / "MON" / mixed casing. Canonical V2 shape is lowercase
    // 3-letter ("mon"/"tue"/etc per DAYS). Lowercase + slice(0,3) covers all
    // observed casings; unknown strings simply don't match a DAYS key and
    // fall through to disabled+defaults, identical to a missing-day source.
    if (typeof cw.day !== "string" || cw.day.length === 0) continue;
    const dayKey = cw.day.toLowerCase().slice(0, 3);
    byDay.set(dayKey, { start: cw.start, end: cw.end });
  }
  return DAYS.map(({ key }) => {
    const cw = byDay.get(key);
    return cw
      ? { day: key, enabled: true, start: cw.start, end: cw.end }
      : { day: key, enabled: false, start: defaults.start, end: defaults.end };
  });
}

/**
 * Lazy initializer for useReducer. Detects the browser timezone on first
 * mount; falls back to DEFAULT_TZ in SSR or locked-down environments.
 * Wired into <WizardPage/> as the third arg of useReducer so it runs
 * exactly once per session.
 *
 * R6 mitigation: timezoneTouched starts false. Slice 2 will flip it true
 * on any manual timezone edit, so re-mounts after navigation don't clobber
 * the operator's choice.
 */
export function createInitialState(): WizardState {
  const detectedTz = detectBrowserTimezone() ?? DEFAULT_TZ;
  const hours = getCallingHours(detectedTz);
  return {
    step: 1,

    name: "",
    timezone: detectedTz,
    timezoneTouched: false,
    numbersText: "",
    audienceSource: "cio",
    cioPhones: "",
    voizoSegmentId: null,
    voizoSegmentName: null,
    voizoPhones: "",
    manualPhones: "",
    segmentId: null,
    segmentName: null,
    isTest: false,

    vapiAssistantId: "",
    baseVoiceId: null,
    voiceId: "",
    systemPrompt: "",

    campaignType: "fixed",
    scheduleRows: initialScheduleRows(hours.start, hours.end),
    startMode: "now",
    delayMinutes: 60,
    scheduledDate: "",

    recurrencePattern: defaultRecurrencePattern(new Date(), detectedTz),
    recurrenceErrors: [],

    smsEnabled: true,
    smsMessage: DEFAULT_SMS_MESSAGE,
    smsLink: DEFAULT_SMS_LINK,
    smsOptout: SMS_OPTOUT_FOOTER,
    smsLinkEditing: false,
    smsOptoutEditing: false,

    saving: false,
    error: null,
  };
}

function detectBrowserTimezone(): string | null {
  try {
    if (typeof Intl !== "undefined") {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    }
  } catch { /* swallow — fall back to DEFAULT_TZ */ }
  return null;
}

/**
 * Country-aware timezone cascade (helpful default, NOT a lockdown).
 *
 * Behavior — autonomy-first per feedback_operator_autonomy_with_guardrails:
 *  - If the operator has explicitly picked a timezone (timezoneTouched=true),
 *    this is a no-op. Their pick wins; banner + Next-click confirm in page.tsx
 *    surface any mismatch as advisory.
 *  - Otherwise, detect the audience's country from phone prefixes and set a
 *    sensible default if the current timezone isn't in the country's allowed
 *    set. This is system-set, so `timezoneTouched` STAYS false — subsequent
 *    audience changes can re-cascade if the operator switches countries.
 *  - No-op when detection returns null (mixed/small/unknown audiences).
 */
function applyDetectedTimezone(state: WizardState): WizardState {
  if (state.timezoneTouched) return state;
  const { country } = detectAudienceCountry(parsePhoneList(state.numbersText));
  if (!country) return state;
  const allowed = allowedTimezonesForCountry(country);
  if (!allowed || allowed.includes(state.timezone)) return state;
  const newTz = allowed[0];
  const hours = getCallingHours(newTz);
  return {
    ...state,
    timezone: newTz,
    scheduleRows: state.scheduleRows.map((r) => ({ ...r, start: hours.start, end: hours.end })),
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "GOTO_STEP":
      return { ...state, step: action.step };
    case "NEXT":
      return state.step < 5 ? { ...state, step: (state.step + 1) as Step } : state;
    case "BACK":
      return state.step > 1 ? { ...state, step: (state.step - 1) as Step } : state;

    case "SET_AUDIENCE_FIELDS": {
      let next: WizardState = { ...state, ...action.payload };
      // Timezone cascade — mirror classic page-classic.tsx:298-303.
      // When the operator picks a new timezone, every per-day row's
      // start/end resets to the new region's calling window. Enabled
      // flags are preserved.
      if (action.payload.timezone && action.payload.timezone !== state.timezone) {
        const hours = getCallingHours(action.payload.timezone);
        next.scheduleRows = state.scheduleRows.map((r) => ({ ...r, start: hours.start, end: hours.end }));
        next.timezoneTouched = true; // R6: any explicit timezone set blocks future auto-detects
      }
      // 2026-05-22: keep numbersText synced with the active source's cache.
      // The active tab's phones are the operator-facing "what will I dial"
      // truth; downstream consumers (buildCreateInput etc.) read numbersText.
      // Two cases:
      //   - Payload set numbersText directly → operator typed in the manual
      //     textarea (or a prefill effect set it). Mirror to manualPhones
      //     when on the manual tab so the cache stays consistent.
      //   - Payload didn't set numbersText → derive from active source's cache.
      if ("numbersText" in action.payload) {
        if (next.audienceSource === "manual") next.manualPhones = next.numbersText;
      } else {
        const activeSource = next.audienceSource;
        next.numbersText =
          activeSource === "cio" ? next.cioPhones :
          activeSource === "voizo" ? next.voizoPhones :
          next.manualPhones;
      }
      // Country-aware TZ guardrail: re-run detection any time the audience
      // changes OR the operator explicitly picks a timezone. The helper is
      // a no-op when detection returns null OR the chosen TZ is already in
      // the allowed set — so this just enforces the guardrail without
      // disturbing legitimate within-set picks (e.g. Vancouver inside +1).
      const audienceChanged = next.numbersText !== state.numbersText;
      const timezoneChanged =
        action.payload.timezone !== undefined &&
        action.payload.timezone !== state.timezone;
      if (audienceChanged || timezoneChanged) {
        next = applyDetectedTimezone(next);
      }
      return next;
    }

    case "IMPORT_SEGMENT": {
      // Atomic update — phones replace numbersText, segmentId + segmentName
      // captured for the Step 11 recurring refresh contract (single-segment
      // imports only). 2026-05-22: also flips audienceSource to "cio" and
      // caches the phones into cioPhones so the CIO tab keeps its selection
      // when the operator briefly visits another tab and returns.
      const phonesText = action.payload.phones.join("\n");
      const next: WizardState = {
        ...state,
        numbersText: phonesText,
        cioPhones: phonesText,
        segmentId: action.payload.segmentId,
        segmentName: action.payload.segmentName,
        audienceSource: "cio",
      };
      // Country-aware TZ guardrail — see applyDetectedTimezone comment.
      return applyDetectedTimezone(next);
    }

    case "SET_AGENT_FIELDS":
      return { ...state, ...action.payload };

    case "SET_SCHEDULE_FIELDS":
      return { ...state, ...action.payload };

    case "SET_SMS_FIELDS":
      return { ...state, ...action.payload };

    case "SET_RECURRENCE_PATTERN":
      return {
        ...state,
        recurrencePattern: action.payload.pattern,
        recurrenceErrors: action.payload.errors ?? state.recurrenceErrors,
      };

    case "SUBMIT_START":
      return { ...state, saving: true, error: null };

    case "SUBMIT_ERROR":
      return { ...state, saving: false, error: action.error };

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Submit helpers (Slice 6)
//
// These pure functions are the single source of truth for what gets sent to
// `/api/vapi/clone-assistant` and `createCampaignV2()`. Ported verbatim from
// page-classic.tsx::handleSubmit (lines 310-440) — every field, every
// branch, every trim. R1: if buildCreateInput drifts from classic, every
// new campaign is silently broken; that's what Slice 6's payload-diff gate
// catches before merge.
// ─────────────────────────────────────────────────────────────────────────

/** Mirrors classic page-classic.tsx:241-244. */
function composedSmsTemplate(state: WizardState): string {
  const parts = [state.smsMessage.trim(), state.smsLink.trim(), state.smsOptout.trim()].filter(
    Boolean,
  );
  return parts.join(" ");
}

/**
 * Best-effort inverse of `composedSmsTemplate`. Splits a stored `sms_template`
 * back into { message, link, optout } so the wizard's three SMS fields can be
 * prefilled when duplicating a campaign.
 *
 * Heuristic: peel the default opt-out footer off the end if it matches, then
 * extract the trailing URL (any http(s) link) into `link`. Custom templates
 * with no trailing URL fall back to `link: ""` and the message keeps its full
 * text. composedSmsTemplate(state) over the returned shape reproduces the
 * original template verbatim either way (modulo whitespace normalization).
 */
export function decomposeSmsTemplate(template: string | null | undefined): {
  message: string;
  link: string;
  optout: string;
} {
  if (!template) return { message: "", link: "", optout: "" };
  let working = template.trim();
  let link = "";
  let optout = "";
  if (working.endsWith(SMS_OPTOUT_FOOTER)) {
    optout = SMS_OPTOUT_FOOTER;
    working = working.slice(0, -SMS_OPTOUT_FOOTER.length).trim();
  }
  const trailingUrl = working.match(/(\s|^)(https?:\/\/\S+)$/);
  if (trailingUrl) {
    link = trailingUrl[2];
    working = working.slice(0, working.length - trailingUrl[2].length).trim();
  }
  return { message: working, link, optout };
}

/** Result returned by POST /api/vapi/clone-assistant on success. */
export interface CloneResult {
  assistantId: string;
  assistantName: string;
  sipUri: string;
  poolSlotId?: string;
  baseAssistantId: string;
  voiceId: string | null;
}

/** Request body for POST /api/vapi/clone-assistant (Fixed path only). */
export function buildCloneRequest(state: WizardState) {
  return {
    baseAssistantId: state.vapiAssistantId.trim(),
    voiceId: state.voiceId || undefined,         // R3: state.voiceId is "" in practice
    systemPrompt: state.systemPrompt || undefined,
    campaignName: state.name.trim(),
  };
}

/**
 * The single point of truth for what we POST to createCampaignV2. Fixed
 * campaigns must pass the clone result; Recurring passes nothing.
 * Throws if `clone` is missing on the Fixed path — that's a programming
 * error, not a user error.
 */
export function buildCreateInput(state: WizardState, clone?: CloneResult): CampaignV2CreateInput {
  if (state.campaignType === "recurring") {
    return {
      name: state.name.trim(),
      systemPrompt: state.systemPrompt,
      // vapiAssistantId omitted — recurring parents have no clone.
      baseAssistantId: state.vapiAssistantId.trim(),
      voiceId: state.voiceId || undefined,
      segmentId: state.segmentId ?? undefined,
      timezone: state.timezone.trim(),
      startAt: null,
      endAt: null,
      callWindows: [],
      smsEnabled: state.smsEnabled,
      smsTemplate: composedSmsTemplate(state) || null,
      smsOnGoalReachedOnly: true,
      numbers: [],
      campaignType: "recurring",
      recurrencePattern: state.recurrencePattern,
      isTest: state.isTest,
    };
  }

  // Fixed path — clone must be present.
  if (!clone) {
    throw new Error("buildCreateInput: Fixed campaign requires a clone result");
  }

  const enabledRows = state.scheduleRows.filter((r) => r.enabled);
  const callWindows: CallWindow[] = enabledRows.map((r) => ({
    day: r.day,
    start: r.start,
    end: r.end,
  }));

  const startAt =
    state.startMode === "delay"
      ? new Date(Date.now() + state.delayMinutes * 60_000).toISOString()
      : state.startMode === "scheduled" && state.scheduledDate
        ? new Date(state.scheduledDate).toISOString()
        : null;

  return {
    name: state.name.trim(),
    systemPrompt: state.systemPrompt,
    vapiAssistantId: clone.assistantId,
    vapiAssistantName: clone.assistantName,
    vapiSipUri: clone.sipUri,
    vapiPoolSlotId: clone.poolSlotId,
    baseAssistantId: clone.baseAssistantId,
    voiceId: clone.voiceId ?? undefined,
    segmentId: state.segmentId ?? undefined,
    timezone: state.timezone.trim(),
    startAt,
    endAt: null,
    callWindows,
    smsEnabled: state.smsEnabled,
    smsTemplate: composedSmsTemplate(state) || null,
    smsOnGoalReachedOnly: true,
    numbers: parsePhoneList(state.numbersText),
    isTest: state.isTest,
  };
}

/**
 * Pre-submit validation. Returns the first error message (or null when OK)
 * — matches classic's early-return setError() style. Mirrors classic lines
 * 310-381. Caller dispatches SUBMIT_ERROR with this message and aborts.
 */
export function validateBeforeSubmit(state: WizardState): string | null {
  if (!state.name.trim()) return "Campaign name is required.";
  if (!state.vapiAssistantId.trim()) return "Pick a Vapi assistant.";

  if (state.campaignType === "recurring") {
    if (state.recurrenceErrors.length > 0) {
      return "Fix the schedule errors below.";
    }
    if (!state.segmentId) {
      return "Recurring campaigns require a single segment. Click one segment row in the importer (not the multi-select checkboxes).";
    }
    return null;
  }

  // Fixed
  const parsedNumbers = parsePhoneList(state.numbersText);
  if (parsedNumbers.length === 0) return "Add at least one valid E.164 phone number.";

  const enabledRows = state.scheduleRows.filter((r) => r.enabled);
  if (enabledRows.length === 0) return "Enable at least one day in the schedule.";

  for (const r of enabledRows) {
    if (r.start >= r.end) {
      return `${r.day.toUpperCase()} start time must be before end time.`;
    }
  }

  // Day-of-week consistency: if the campaign auto-starts at a specific time
  // (delay or scheduled), make sure the day-of-week of the effective start
  // -- evaluated in the campaign timezone -- matches an enabled call window.
  // Silent failure mode otherwise: scheduler logs "outside_call_window" and
  // the campaign sits in draft past its start_at with no calls firing.
  // 4 prior incidents (3 AU + 1 CA tonight) per
  // [[project_campaign_day_window_mismatch]].
  if (state.startMode === "delay" || (state.startMode === "scheduled" && state.scheduledDate)) {
    const effectiveStart =
      state.startMode === "delay"
        ? new Date(Date.now() + state.delayMinutes * 60_000)
        : new Date(state.scheduledDate);
    if (Number.isNaN(effectiveStart.getTime())) {
      return "Pick a valid start date.";
    }
    let expectedDay: string;
    try {
      // Throws RangeError if state.timezone is empty/malformed. Should be
      // unreachable via the wizard UI (timezone is a controlled dropdown),
      // but guard defensively so a corrupted state doesn't crash the form.
      expectedDay = dayOfWeekInTimezone(effectiveStart, state.timezone);
    } catch {
      return "Campaign timezone is invalid. Re-pick the audience or timezone.";
    }
    const enabledDays = new Set<string>(enabledRows.map((r) => r.day));
    if (!enabledDays.has(expectedDay)) {
      return `Start time falls on ${expectedDay.toUpperCase()} (in ${state.timezone}) but no call window is enabled for ${expectedDay.toUpperCase()}. Toggle ${expectedDay.toUpperCase()} on above, or change the start time.`;
    }
  }

  if (state.smsEnabled && state.smsMessage.trim().length === 0) {
    return "SMS message cannot be empty when SMS is enabled.";
  }
  if (state.smsLink.trim() && !state.smsLink.trim().startsWith("https://")) {
    return "SMS link must start with https://";
  }

  return null;
}

/**
 * Step metadata used by the Stepper (left rail) and FooterNav.
 * `defaultSummary` is the placeholder text shown under each step name
 * before that step has any state to summarize. Slices 2-5 will replace
 * these with derived summaries computed from the relevant state slice.
 */
export const STEPS: Array<{ step: Step; label: string; name: string; defaultSummary: string }> = [
  { step: 1, label: "Step 1", name: "Audience",          defaultSummary: "Who you're calling" },
  { step: 2, label: "Step 2", name: "Agent",             defaultSummary: "Pick the AI assistant" },
  { step: 3, label: "Step 3", name: "Schedule",          defaultSummary: "When to call" },
  { step: 4, label: "Step 4", name: "Follow-up",         defaultSummary: "Post-call SMS · optional" },
  { step: 5, label: "Final",  name: "Review & launch",   defaultSummary: "Final check" },
];
