// Recurring child-spawn for the campaign scheduler.
//
// Used by:
//   src/app/api/cron/campaign-scheduler/route.ts (GET handler — recurring branch)
//
// Reads recurring parent campaigns (campaign_type='recurring', status='running')
// and spawns one child Fixed campaign per active day per recurrence_pattern.
// The child is inserted with status='draft' and start_at=today's window open in
// the parent's timezone, so the existing draft→running flow at the scheduler's
// later branch picks it up at window-open time. This avoids the resume-sweep
// auto-pause collision that would happen if the child were created as 'running'
// before its call window opened.
//
// Empty-segment skip (parent.recurrence_pattern.skip_if_empty=true with 0
// phones returned): inserts a child with status='skipped' as a per-day audit
// row. Status='skipped' is allowed by migration 1e.
//
// Idempotency is per-day: spawnChildIfDue queries for an existing child whose
// start_at falls inside today's [start, end) in the parent's timezone. If one
// exists, no second spawn this day.

// Relative imports (2026-07-10, VOZ-132): vitest has no "@/" alias config, and
// this module is now under test (recurringSpawn.test.ts). snapshotCampaignPrompt
// moved to a lazy import inside spawnChildIfDue — its module chain loads
// supabaseServer, which throws at import time without env vars (test poison).
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClone } from "../vapi/cloneAssistant";
import { fetchSegmentPhones } from "../customerio";
import { leaseSlot, patchPhoneAssistant, linkSlot, releaseSlot } from "../vapi/sipPool";
import { parsePhoneList, nameByE164 } from "../campaignV2Shared";
import type { DayOfWeek, RecurrencePattern } from "../types/recurrence";

export interface RecurringParent {
  id: string;
  name: string;
  timezone: string;
  recurrence_pattern: RecurrencePattern | null;
  segment_id: number | null;
  base_assistant_id: string | null;
  voice_id: string | null;
  system_prompt: string;
  sms_enabled: boolean;
  sms_template: string | null;
  sms_on_goal_reached_only: boolean | null;
  sms_consent_mode: string | null;
  // Inherited by spawned children so test-flagged parents don't spawn
  // production-visible children (audit 2026-05-22 HIGH H3). Without this,
  // every spawned child has DB DEFAULT false → pollutes Audience suggestions.
  is_test: boolean;
  // Real-time top-up mode (VOZ-132): children spawn EMPTY and the per-minute
  // poll (realtimePoll.ts) is their only number source. Optional so callers/
  // selects that predate the realtime migration keep compiling and behaving.
  realtime?: boolean;
  daily_cap?: number | null;
  // Operator controls (VOZ-132 §7). Children MUST inherit these — the dialer
  // and voice-status webhooks read the CHILD row, so without passthrough the
  // operator's chosen gap/tries silently never apply (review finding 2026-07-10).
  retry_interval_minutes?: number | null;
  max_attempts?: number | null;
  // Last-resort SMS (§8): same child-row rule — the end-of-call webhook and
  // the last-resort sweep both read the CHILD campaign.
  sms_last_resort_template?: string | null;
}

export interface DueCheckResult {
  due: boolean;
  reason:
    | "due"
    | "before_start_date"
    | "end_reached"
    | "not_an_active_day"
    | "off_week"
    | "in_exception_dates"
    | "before_spawn_time";
}

export type SpawnOutcome =
  | { result: "spawned"; childId: string; dialCount: number; windowStart: string; windowEnd: string }
  | { result: "segment_empty_skipped"; childId: string }
  | { result: "already_spawned_today"; childId: string }
  | { result: "not_due"; reason: DueCheckResult["reason"] }
  | { result: "budget_full" }
  | { result: "lost_spawn_race" }
  | { result: "spawn_failed"; details: string };

// ── Timezone helpers (Intl.DateTimeFormat — zero deps, DST-aware) ────────

function todayInTz(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function todayDowInTz(now: Date, tz: string): DayOfWeek {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  })
    .format(now)
    .toLowerCase()
    .slice(0, 3);
  return short as DayOfWeek;
}

function todayHHMMInTz(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const rawHour = parts.find((p) => p.type === "hour")!.value;
  // Some locale+timezone combos emit "24" for midnight; normalize to "00".
  const h = (rawHour === "24" ? "00" : rawHour).padStart(2, "0");
  const m = parts.find((p) => p.type === "minute")!.value.padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Convert a (YYYY-MM-DD, HH:MM, timezone) triple to a UTC ISO timestamp.
 * Uses Intl.DateTimeFormat's DST-aware tz mapping to find the offset that
 * was in effect at that local moment, then applies it.
 */
function isoForLocalTime(dateStr: string, timeStr: string, tz: string): string {
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);

  // Naive UTC interpretation of the wall-clock time
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);

  // What does the target timezone display at that instant?
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcGuess));
  const tzY = +parts.find((p) => p.type === "year")!.value;
  const tzMo = +parts.find((p) => p.type === "month")!.value;
  const tzD = +parts.find((p) => p.type === "day")!.value;
  const rawTzHour = parts.find((p) => p.type === "hour")!.value;
  const tzH = rawTzHour === "24" ? 0 : +rawTzHour;
  const tzMi = +parts.find((p) => p.type === "minute")!.value;

  const tzAsUtcMs = Date.UTC(tzY, tzMo - 1, tzD, tzH, tzMi);
  const offsetMs = utcGuess - tzAsUtcMs;

  return new Date(utcGuess + offsetMs).toISOString();
}

export function startOfDayIsoInTz(now: Date, tz: string): string {
  return isoForLocalTime(todayInTz(now, tz), "00:00", tz);
}

export function endOfDayIsoInTz(now: Date, tz: string): string {
  // "End of day" = start of NEXT day, so we can use < (exclusive) in queries.
  const today = todayInTz(now, tz);
  const [y, m, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  const yy = tomorrow.getUTCFullYear();
  const mm = String(tomorrow.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getUTCDate()).padStart(2, "0");
  return isoForLocalTime(`${yy}-${mm}-${dd}`, "00:00", tz);
}

// ── Legal call-window cap (compliance) ───────────────────────────────────
//
// Latest legal call END time (exclusive) by jurisdiction, sourced from VOZ-129:
// AU / NZ / JP cap at 20:00 (8pm); US / CA / UK allow 21:00 (9pm). Any zone not
// listed falls back to 21:00 — the pre-clamp ceiling — so this can only ever
// LOWER an over-cap window, never tighten one that was already legal.
//
// This is a LEGAL input, not a heuristic: extend the 20:00 set only with an
// ops/Maria-confirmed jurisdiction (e.g. EU-strict zones, currently unconfirmed
// → left at the permissive 21:00 default rather than guessed).
//
// ponytail: static wall-clock caps — no DST/offset nuance needed (8pm local is
// 8pm local); add a jurisdiction here when its cap is confirmed.
const CAP_2000_ZONES = ["Pacific/Auckland", "Asia/Tokyo"];

export function legalCallEndCap(timezone: string): string {
  const tz = timezone ?? "";
  if (tz.startsWith("Australia/") || CAP_2000_ZONES.includes(tz)) return "20:00";
  return "21:00";
}

/**
 * Clamp a "HH:MM" window end DOWN to the timezone's legal cap. Zero-padded 24h
 * strings compare lexicographically = chronologically, so a plain `>` is safe.
 * Only ever lowers the end; start is the caller's concern (a start at/after the
 * cap would collapse the window to no-dial — fail-closed, the safe direction).
 */
export function clampCallEndToLegalCap(end: string, timezone: string): string {
  const cap = legalCallEndCap(timezone);
  return end > cap ? cap : end;
}

// ── Due-check (pure logic) ───────────────────────────────────────────────

/**
 * Whole Sunday-aligned calendar weeks between two YYYY-MM-DD dates. Both dates
 * are already resolved to the campaign timezone by the caller, so this is pure
 * UTC date arithmetic and therefore DST-immune. Each date is snapped back to
 * the Sunday that begins its calendar week before diffing, so all active
 * weekdays within one calendar week share the same parity (iCalendar RRULE
 * INTERVAL semantics, WKST=SU — matches the editor's Sunday-first day pills).
 */
function weeksSinceStartAligned(startDate: string, today: string): number {
  const MS_PER_DAY = 86_400_000;
  const toUtcMidnight = (s: string): number => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const startMs = toUtcMidnight(startDate);
  const todayMs = toUtcMidnight(today);
  const startWeek = startMs - new Date(startMs).getUTCDay() * MS_PER_DAY;
  const todayWeek = todayMs - new Date(todayMs).getUTCDay() * MS_PER_DAY;
  return Math.round((todayWeek - startWeek) / (7 * MS_PER_DAY));
}

export function isDueToday(
  pattern: RecurrencePattern,
  campaignTimezone: string,
  now: Date,
): DueCheckResult {
  const today = todayInTz(now, campaignTimezone);
  const dow = todayDowInTz(now, campaignTimezone);
  const hhmm = todayHHMMInTz(now, campaignTimezone);

  if (today < pattern.start_date) return { due: false, reason: "before_start_date" };

  if (pattern.end_kind === "on_date" && pattern.end_date && today > pattern.end_date) {
    return { due: false, reason: "end_reached" };
  }
  if (
    pattern.end_kind === "after_n" &&
    pattern.end_after_n != null &&
    (pattern.spawned_count ?? 0) >= pattern.end_after_n
  ) {
    return { due: false, reason: "end_reached" };
  }

  if (!pattern.days_of_week.includes(dow)) return { due: false, reason: "not_an_active_day" };

  // repeat_every_weeks: skip weeks that aren't an active multiple of the
  // interval, counting Sunday-aligned calendar weeks from start_date. The
  // `interval > 1` guard keeps the common interval=1 (and any malformed
  // 0/negative) a no-op — identical to pre-2026-05-29 behavior. No UI sets
  // this field > 1 yet (audit 2026-05-29 F9); this closes the latent trap so a
  // future interval control can't silently over-spawn (each spawn = a Vapi
  // clone + leased SIP slot + per-minute spend).
  const interval = pattern.repeat_every_weeks ?? 1;
  if (interval > 1 && weeksSinceStartAligned(pattern.start_date, today) % interval !== 0) {
    return { due: false, reason: "off_week" };
  }

  if (pattern.exception_dates.includes(today)) return { due: false, reason: "in_exception_dates" };

  if (hhmm < pattern.segment_refresh_time) return { due: false, reason: "before_spawn_time" };

  return { due: true, reason: "due" };
}

// ── Spawn orchestration ──────────────────────────────────────────────────

export async function spawnChildIfDue(
  supabase: SupabaseClient,
  vapiKey: string,
  parent: RecurringParent,
  now: Date,
  leasedBudget: number,
): Promise<SpawnOutcome> {
  if (!parent.recurrence_pattern || !parent.timezone || !parent.base_assistant_id) {
    return {
      result: "spawn_failed",
      details: "parent missing recurrence_pattern, timezone, or base_assistant_id",
    };
  }
  if (parent.segment_id == null) {
    return {
      result: "spawn_failed",
      details: "parent has no segment_id (multi-select imports aren't supported for recurring)",
    };
  }

  // ── 1. Due check (pure) ──
  const check = isDueToday(parent.recurrence_pattern, parent.timezone, now);
  if (!check.due) return { result: "not_due", reason: check.reason };

  // ── 2. Idempotency: already spawned today? ──
  const dayStart = startOfDayIsoInTz(now, parent.timezone);
  const dayEnd = endOfDayIsoInTz(now, parent.timezone);
  const { data: existing, error: existingErr } = await supabase
    .from("campaigns_v2")
    .select("id")
    .eq("parent_campaign_id", parent.id)
    .gte("start_at", dayStart)
    .lt("start_at", dayEnd)
    .limit(1)
    .maybeSingle();
  if (existingErr) {
    return { result: "spawn_failed", details: `idempotency query: ${existingErr.message}` };
  }
  if (existing) return { result: "already_spawned_today", childId: existing.id };

  // ── 3. Today's call window in parent timezone ──
  const dow = todayDowInTz(now, parent.timezone);
  const todayStr = todayInTz(now, parent.timezone);
  const hours = parent.recurrence_pattern.call_hours_by_day[dow];
  if (!hours || !hours.start || !hours.end) {
    return { result: "spawn_failed", details: `no call hours configured for ${dow}` };
  }
  // Compliance clamp: a spawned child's dial window END can never exceed the
  // destination's legal calling cap, regardless of what the parent stored or an
  // operator widened it to. VOZ-129 fixed only the UI default (21:00→20:00) for
  // NEW patterns; existing/edited parents can still hold 21:00 in a 20:00
  // jurisdiction (e.g. the live AU always-on parent). Clamp DOWN only — start is
  // untouched — so a legal 9pm window (US/CA/UK) is never shortened.
  const windowEnd = clampCallEndToLegalCap(hours.end, parent.timezone);
  const startAtIso = isoForLocalTime(todayStr, hours.start, parent.timezone);
  const endAtIso = isoForLocalTime(todayStr, windowEnd, parent.timezone);
  const todaysCallWindow = [{ day: dow, start: hours.start, end: windowEnd }];

  // ── 4. Pull segment phones (SKIPPED for realtime parents — VOZ-132: the
  //       per-minute poll is the sole number source, children spawn empty) ──
  let phones: string[] = [];
  let namesByPhone = new Map<string, string>();
  if (!parent.realtime) {
    const segmentResult = await fetchSegmentPhones(parent.segment_id);
    if (!segmentResult.ok) {
      return { result: "spawn_failed", details: `segment fetch: ${segmentResult.error}` };
    }
    phones = parsePhoneList(segmentResult.phones.join("\n"));
    // Greet-by-name Ramp 1: names ride the same profile fetch, keyed by the
    // normalized phone so they line up with the rows inserted below.
    namesByPhone = nameByE164(segmentResult.entries);

    // ── 5. Empty-segment branch (non-realtime only: an empty realtime child
    //       is the NORMAL morning state, not a skip condition) ──
    if (phones.length === 0 && parent.recurrence_pattern.skip_if_empty) {
      const skipPayload = buildChildPayload({
        parent,
        todayStr,
        startAtIso,
        endAtIso,
        todaysCallWindow,
        status: "skipped",
        assistantId: null,
        slotId: null,
        sipUri: null,
      });
      const { data: skippedChild, error: skipErr } = await supabase
        .from("campaigns_v2")
        .insert(skipPayload)
        .select("id")
        .single();
      if (skipErr) {
        return { result: "spawn_failed", details: `insert skipped child: ${skipErr.message}` };
      }
      await updateParentLastSpawnDate(supabase, parent, todayStr).catch((err) => {
        console.warn(`[recurringSpawn] ${parent.id}: last_spawn_date update failed:`, err);
      });
      return { result: "segment_empty_skipped", childId: skippedChild.id };
    }
  }

  // ── 6. Budget check (refreshed by caller per iteration) ──
  if (leasedBudget <= 0) return { result: "budget_full" };

  // ── 7. Clone the base assistant ──
  const cloneResult = await createClone(vapiKey, parent.base_assistant_id, {
    voiceId: parent.voice_id ?? undefined,
    systemPrompt: parent.system_prompt,
    campaignName: `${parent.name} (${todayStr})`,
  });
  if (!cloneResult.ok) {
    return { result: "spawn_failed", details: `createClone: ${cloneResult.error}` };
  }
  const clone = cloneResult.clone;

  // ── 8. Lease a slot ──
  let slot;
  try {
    slot = await leaseSlot(supabase, clone.id);
  } catch (err) {
    await deleteCloneBestEffort(vapiKey, clone.id);
    return {
      result: "spawn_failed",
      details: `leaseSlot threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!slot) {
    await deleteCloneBestEffort(vapiKey, clone.id);
    return { result: "spawn_failed", details: "SIP pool exhausted (no free slot)" };
  }

  // ── 9. PATCH the Vapi phone to point at the new clone ──
  const patchRes = await patchPhoneAssistant(vapiKey, slot.vapi_phone_number_id, clone.id);
  if (!patchRes.ok) {
    await releaseSlot(supabase, slot.id).catch(() => {});
    await deleteCloneBestEffort(vapiKey, clone.id);
    return {
      result: "spawn_failed",
      details: `patchPhoneAssistant: HTTP ${patchRes.status} ${patchRes.body.slice(0, 200)}`,
    };
  }

  // ── 10. INSERT the child campaign row ──
  const childPayload = buildChildPayload({
    parent,
    todayStr,
    startAtIso,
    endAtIso,
    todaysCallWindow,
    status: "draft",
    assistantId: clone.id,
    slotId: slot.id,
    sipUri: slot.sip_uri,
  });
  const { data: childRow, error: insertErr } = await supabase
    .from("campaigns_v2")
    .insert(childPayload)
    .select("id")
    .single();
  if (insertErr || !childRow) {
    // We already cloned + leased this tick; release both regardless of the
    // failure reason (no orphan left behind).
    await releaseSlot(supabase, slot.id).catch(() => {});
    await deleteCloneBestEffort(vapiKey, clone.id);
    // 23505 = unique_violation on (parent_campaign_id, start_at): a concurrent
    // scheduler tick already inserted today's child for this parent. That DB
    // constraint is the race-proof idempotency guard (the SELECT at step 2 is a
    // best-effort fast path). The other tick won and we've cleaned up, so this
    // is a benign lost race — not a failure, no double dial. Audit 2026-05-29 F3.
    if (insertErr?.code === "23505") {
      return { result: "lost_spawn_race" };
    }
    return {
      result: "spawn_failed",
      details: `INSERT child campaign: ${insertErr?.message ?? "no row returned"}`,
    };
  }

  // ── 11. INSERT campaign_numbers_v2 rows ──
  const numberRows = phones.map((phone) => ({
    campaign_id: childRow.id,
    phone_e164: phone,
    outcome: "pending" as const,
    display_name: namesByPhone.get(phone) ?? null,
  }));
  if (numberRows.length > 0) {
    const { error: numbersErr } = await supabase.from("campaign_numbers_v2").insert(numberRows);
    if (numbersErr) {
      await supabase.from("campaigns_v2").delete().eq("id", childRow.id);
      await releaseSlot(supabase, slot.id).catch(() => {});
      await deleteCloneBestEffort(vapiKey, clone.id);
      return { result: "spawn_failed", details: `INSERT numbers: ${numbersErr.message}` };
    }
  }

  // ── 12. linkSlot — back-link slot to child (matches createCampaignV2 pattern) ──
  try {
    const linked = await linkSlot(supabase, {
      slotId: slot.id,
      campaignId: childRow.id,
      expectedAssistantId: clone.id,
    });
    if (!linked) {
      console.warn(
        `[recurringSpawn] linkSlot returned false for slot ${slot.id} ` +
          `(child ${childRow.id}, clone ${clone.id}). Heartbeat reconciliation will surface this.`,
      );
    }
  } catch (err) {
    console.warn(`[recurringSpawn] linkSlot threw (non-fatal):`, err);
  }

  // ── 12b. Realtime rollover (VOZ-132 spec §9 "late evening"): carry
  // yesterday's uncalled players into today's child, close yesterday's.
  // Non-fatal: a rollover failure must not fail an otherwise-good spawn —
  // uncarried leftovers are retried at the NEXT spawn (old rows stay open).
  if (parent.realtime) {
    const { rolloverLeftovers } = await import("./realtimePoll");
    await rolloverLeftovers(supabase, parent.id, childRow.id, dayStart).catch((err) => {
      console.warn(`[recurringSpawn] ${parent.id}: rollover failed (non-fatal):`, err);
    });
  }

  // ── 13. Update parent counters ──
  await updateParentSpawnCounters(supabase, parent, todayStr).catch((err) => {
    console.warn(`[recurringSpawn] ${parent.id}: counter update failed:`, err);
  });

  // ── 14. Best-effort prompt-version snapshot (slice 2 — eval-loop keystone) ──
  // Capture the spawned child's effective prompt. Awaited (serverless may freeze
  // after return); snapshotCampaignPrompt never throws, so a snapshot failure
  // cannot turn a successful spawn into a failure. Only the cloned path reaches
  // here — the empty-segment skip branch (no clone) returned earlier.
  // Lazy import: its chain loads supabaseServer (throws without env), which
  // would poison this module for vitest (recurringSpawn.test.ts).
  const { snapshotCampaignPrompt } = await import("../promptVersionData");
  await snapshotCampaignPrompt(childRow.id, clone.id);

  return {
    result: "spawned",
    childId: childRow.id,
    dialCount: phones.length,
    windowStart: hours.start,
    windowEnd,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

export function buildChildPayload(args: {
  parent: RecurringParent;
  todayStr: string;
  startAtIso: string;
  endAtIso: string;
  todaysCallWindow: Array<{ day: DayOfWeek; start: string; end: string }>;
  status: "draft" | "skipped";
  assistantId: string | null;
  slotId: string | null;
  sipUri: string | null;
}) {
  const { parent, todayStr, startAtIso, endAtIso, todaysCallWindow, status, assistantId, slotId, sipUri } =
    args;
  return {
    name: `${parent.name} (${todayStr})`,
    system_prompt: parent.system_prompt,
    vapi_assistant_id: assistantId,
    vapi_pool_slot_id: slotId,
    vapi_sip_uri: sipUri,
    base_assistant_id: parent.base_assistant_id,
    voice_id: parent.voice_id,
    segment_id: parent.segment_id,
    timezone: parent.timezone,
    start_at: startAtIso,
    end_at: endAtIso,
    call_windows: todaysCallWindow,
    sms_enabled: parent.sms_enabled,
    sms_template: parent.sms_template,
    sms_on_goal_reached_only: parent.sms_on_goal_reached_only ?? true,
    sms_consent_mode: parent.sms_consent_mode ?? "verbal_yes",
    status,
    campaign_type: "fixed" as const,
    parent_campaign_id: parent.id,
    recurrence_pattern: null,
    is_test: parent.is_test,
    // Operator controls inherit unconditionally (columns pre-date this build,
    // so no deploy-order concern): the dialer + webhooks read the CHILD row.
    retry_interval_minutes: parent.retry_interval_minutes ?? 90,
    max_attempts: parent.max_attempts ?? 3,
    // Conditional keys (voicemail_autohangup precedent): absent for
    // non-realtime parents so pre-migration DBs never see unknown columns.
    // Children carry the flag so the scheduler's keep-awake guard can read
    // it off the child row, and the cap so the poll enforces it per day.
    ...(parent.realtime ? { realtime: true, daily_cap: parent.daily_cap ?? null } : {}),
    // Last-resort SMS (§8) inherits the same way — webhook + sweep read the child.
    ...(typeof parent.sms_last_resort_template === "string" && parent.sms_last_resort_template.trim().length > 0
      ? { sms_last_resort_template: parent.sms_last_resort_template }
      : {}),
  };
}

async function updateParentLastSpawnDate(
  supabase: SupabaseClient,
  parent: RecurringParent,
  todayStr: string,
): Promise<void> {
  const next: RecurrencePattern = {
    ...parent.recurrence_pattern!,
    last_spawn_date: todayStr,
  };
  const { error } = await supabase
    .from("campaigns_v2")
    .update({ recurrence_pattern: next })
    .eq("id", parent.id);
  if (error) throw error;
}

async function updateParentSpawnCounters(
  supabase: SupabaseClient,
  parent: RecurringParent,
  todayStr: string,
): Promise<void> {
  const current = parent.recurrence_pattern!;
  const next: RecurrencePattern = {
    ...current,
    last_spawn_date: todayStr,
    spawned_count: (current.spawned_count ?? 0) + 1,
  };
  const { error } = await supabase
    .from("campaigns_v2")
    .update({ recurrence_pattern: next })
    .eq("id", parent.id);
  if (error) throw error;
}

export async function deleteCloneBestEffort(vapiKey: string, cloneId: string): Promise<void> {
  // Best-effort, but LOUD. A silently-swallowed failure here orphans a billable
  // Vapi assistant (no quota monitoring — see project_openai_credential_vapi).
  // Both failure modes are logged: an HTTP non-2xx (the previous code only
  // caught *thrown* errors, so a 401 from a rotated key / 404 / 5xx returned
  // "successfully" and orphaned the clone) and a network throw. No key is
  // logged — it lives in the request header, never in the URL/status/message.
  // Audit 2026-05-29 F13. Heartbeat reconciliation still surfaces any orphan.
  try {
    const res = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(cloneId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiKey}` },
    });
    if (!res.ok) {
      console.warn(
        `[recurringSpawn] deleteCloneBestEffort: Vapi DELETE returned ${res.status} for clone ${cloneId} — assistant may be orphaned.`,
      );
    }
  } catch (err) {
    console.warn(
      `[recurringSpawn] deleteCloneBestEffort: Vapi DELETE threw for clone ${cloneId} ` +
        `(${err instanceof Error ? err.message : String(err)}) — assistant may be orphaned.`,
    );
  }
}
