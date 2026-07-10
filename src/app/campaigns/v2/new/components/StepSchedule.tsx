"use client";

import { useMemo, type Dispatch } from "react";
import {
  CalendarDays, Globe2, Info, Play, Repeat, Target, Timer, Zap,
} from "lucide-react";

import { RecurrenceEditor } from "@/components/RecurrenceEditor";

import {
  DAYS, getCallingHours, TIMEZONE_OPTIONS,
  type Day, type ScheduleRow, type WizardAction, type WizardState,
} from "../wizardState";
import TimePickerField from "@/components/TimePickerField";
import DateTimePickerField from "@/components/DateTimePickerField";
import StyledSelect from "@/components/StyledSelect";
import { dayOfWeekInTimezone } from "@/lib/dayOfWeekInTimezone";
import { clockHHMMInTimezone, isWithinCallWindowAt, minWindowMinutes, retryFitsShortestWindow } from "@/lib/scheduleWindow";

interface Props {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}

const DELAY_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "30 min",  value: 30 },
  { label: "1 hour",  value: 60 },
  { label: "2 hours", value: 120 },
  { label: "4 hours", value: 240 },
  { label: "8 hours", value: 480 },
  { label: "24 hours", value: 1440 },
];

// Operator controls (VOZ-132 §7). The whitelists mirror normalizeOperatorControls.
const RETRY_GAP_PRESETS: ReadonlyArray<number> = [30, 60, 90];
const MAX_TRIES_PRESETS: ReadonlyArray<number> = [2, 3, 4, 5];

function formatLocalTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export default function StepSchedule({ state, dispatch }: Props) {
  const isRecurring = state.campaignType === "recurring";

  // Run-once helpers — mutate scheduleRows immutably and dispatch a full
  // SET_SCHEDULE_FIELDS update so the reducer stays dumb (caller computes
  // the new array — per plan's fat-action pattern).
  // "Real-time" is a third tile, but under the hood = recurring + realtime flag
  // (children spawn empty; the per-minute poll fills them — VOZ-132).
  function setRunMode(next: "fixed" | "recurring" | "realtime") {
    dispatch({
      type: "SET_SCHEDULE_FIELDS",
      payload: {
        campaignType: next === "fixed" ? "fixed" : "recurring",
        realtime: next === "realtime",
      },
    });
  }
  function toggleDay(day: Day) {
    const next = state.scheduleRows.map((r) =>
      r.day === day ? { ...r, enabled: !r.enabled } : r,
    );
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { scheduleRows: next } });
  }
  function updateRowTime(day: Day, patch: Partial<ScheduleRow>) {
    const next = state.scheduleRows.map((r) =>
      r.day === day ? { ...r, ...patch } : r,
    );
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { scheduleRows: next } });
  }
  function setStartMode(mode: "now" | "delay" | "scheduled") {
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { startMode: mode } });
  }
  function setDelayMinutes(value: number) {
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { delayMinutes: value } });
  }
  function setScheduledDate(value: string) {
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { scheduledDate: value } });
  }
  function setGoalTargetText(value: string) {
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { goalTargetText: value } });
  }

  const enabledRows = useMemo(
    () => state.scheduleRows.filter((r) => r.enabled),
    [state.scheduleRows],
  );
  const callWindows = useMemo(
    () => enabledRows.map((r) => ({ day: r.day, start: r.start, end: r.end })),
    [enabledRows],
  );

  const tzShort = state.timezone.split("/").pop()?.replace(/_/g, " ") ?? state.timezone;
  const tzHours = getCallingHours(state.timezone);

  return (
    <div className="flex-1 flex flex-col">
      <h1 className="text-[22px] font-bold tracking-tight">When should it run?</h1>
      <p className="text-sm text-[var(--text-3)] mt-1.5 leading-relaxed">
        Pick one-time or repeating, then choose your days and hours. Voizo enforces the legal
        calling window for the audience&apos;s region ({tzHours.start}–{tzHours.end} {tzShort}).
      </p>

      <div className="mt-7 flex flex-col gap-[18px]">
        {/* Run mode tiles */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
          <ChoiceTile
            active={!isRecurring}
            onClick={() => setRunMode("fixed")}
            icon={<Play size={14} />}
            name="Run once"
            description="Dial through this list once, then stop. Best for promos and tests."
          />
          <ChoiceTile
            active={isRecurring && !state.realtime}
            onClick={() => setRunMode("recurring")}
            icon={<Repeat size={14} />}
            name="Repeat daily"
            description="Runs every scheduled day with the latest list."
          />
          <ChoiceTile
            active={isRecurring && state.realtime}
            onClick={() => setRunMode("realtime")}
            icon={<Zap size={14} />}
            name="Real-time"
            description="Calls new sign-ups within minutes, all day."
          />
        </div>

        {/* Campaign goal (target) — optional. Applies to both run modes. */}
        <div className="flex flex-col gap-2">
          <label
            htmlFor="campaign-goal-target"
            className="text-xs font-medium text-[var(--text-2)] inline-flex items-center gap-1.5"
          >
            <Target size={13} className="text-[var(--text-3)]" />
            Campaign goal (target)
          </label>
          <input
            id="campaign-goal-target"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={state.goalTargetText}
            onChange={(e) => setGoalTargetText(e.target.value)}
            placeholder="e.g. 50"
            className="w-full sm:max-w-[12rem] px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
          />
          <p className="text-[11px] text-[var(--text-3)] leading-snug">
            Optional. Target number of successful outcomes (e.g. deposits) for this
            campaign — shown as X / Y in the performance report.
          </p>
        </div>

        {/* Operator controls (VOZ-132 §7): retry gap + max tries for every run
            mode; daily cap only for Real-time (its cost brake). */}
        {/* span + role=group (not <label>): these name BUTTON GROUPS, and a
            label without an associated form control is an a11y defect. */}
        <div className="flex flex-col gap-2" role="group" aria-label="Retry gap">
          <span className="text-xs font-medium text-[var(--text-2)]">
            Retry gap
            <span className="text-[11px] text-[var(--text-3)] font-normal"> — wait before trying a player again</span>
          </span>
          <div className="flex flex-wrap gap-2">
            {RETRY_GAP_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { retryGapMinutes: v } })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  state.retryGapMinutes === v
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                    : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30 hover:text-blue-400"
                }`}
              >
                {v} min
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2" role="group" aria-label="Max tries per player">
          <span className="text-xs font-medium text-[var(--text-2)]">
            Max tries per player
          </span>
          <div className="flex flex-wrap gap-2">
            {MAX_TRIES_PRESETS.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { maxTries: v } })}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  state.maxTries === v
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                    : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30 hover:text-blue-400"
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {isRecurring && state.realtime && (
          <div className="flex flex-col gap-2">
            <label
              htmlFor="realtime-daily-cap"
              className="text-xs font-medium text-[var(--text-2)]"
            >
              Daily cap
              <span className="text-[11px] text-[var(--text-3)] font-normal"> — max players added per day</span>
            </label>
            <input
              id="realtime-daily-cap"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={state.dailyCapText}
              onChange={(e) =>
                dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { dailyCapText: e.target.value } })
              }
              placeholder="e.g. 150"
              className="w-full sm:max-w-[12rem] px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
            />
            <p className="text-[11px] text-[var(--text-3)] leading-snug">
              Required. When the cap is hit, new sign-ups wait until tomorrow.
            </p>
          </div>
        )}

        {/* Branch */}
        {isRecurring ? (
          <RecurrenceEditor
            value={state.recurrencePattern}
            onChange={(pattern) =>
              dispatch({ type: "SET_RECURRENCE_PATTERN", payload: { pattern } })
            }
            campaignTimezone={state.timezone}
            segmentName={state.segmentName ?? undefined}
            errors={state.recurrenceErrors}
            timezoneSlot={
              <StyledSelect
                value={state.timezone}
                onChange={(value) =>
                  dispatch({ type: "SET_AUDIENCE_FIELDS", payload: { timezone: value } })
                }
                options={TIMEZONE_OPTIONS}
                icon={<Globe2 size={14} />}
                placeholder="Pick a timezone…"
              />
            }
          />
        ) : (
          <>
            {/* Active days */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-[var(--text-2)]">Active days</label>
              <div className="flex gap-1.5">
                {DAYS.map(({ key, short }) => {
                  const row = state.scheduleRows.find((r) => r.day === key)!;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => toggleDay(key)}
                      className={`flex-1 py-2.5 rounded-xl border-[1.5px] text-xs font-semibold font-mono tracking-wider transition ${
                        row.enabled
                          ? "border-blue-500 bg-blue-500/[0.10] text-blue-400"
                          : "border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-3)] hover:border-[var(--border-2)] hover:text-[var(--text-2)]"
                      }`}
                    >
                      {short}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Per-day call hours (only enabled days) */}
            {enabledRows.length === 0 ? (
              <p className="text-xs text-[var(--text-3)] -mt-2">
                Pick at least one day above to set call hours.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-[var(--text-2)]">
                  Call hours{" "}
                  <span className="text-[11px] text-[var(--text-3)] font-normal">in {state.timezone}</span>
                </label>
                <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] divide-y divide-[var(--border)] overflow-visible">
                  {enabledRows.map((row) => (
                    <div key={row.day} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-sm font-medium text-[var(--text-1)] w-[5rem] shrink-0 capitalize">
                        {DAYS.find((d) => d.key === row.day)?.label}
                      </span>
                      <TimePickerField
                        value={row.start}
                        onChange={(v) => updateRowTime(row.day, { start: v })}
                      />
                      <span className="text-xs text-[var(--text-3)] shrink-0">to</span>
                      <TimePickerField
                        value={row.end}
                        onChange={(v) => updateRowTime(row.day, { end: v })}
                      />
                    </div>
                  ))}
                </div>
                {enabledRows.some((r) => r.start >= r.end) && (
                  <p className="text-xs text-red-400">
                    Each row&apos;s start time must be before its end time.
                  </p>
                )}
              </div>
            )}

            {/* Retry-vs-window guard: when the chosen retry gap exceeds the
                shortest window, a no-answer's retry is scheduled past the window close, so
                it only fires when the window NEXT reopens (next day / next enabled window)
                — effectively one attempt per window. Advisory only (operator may want short
                windows). */}
            {enabledRows.length > 0 && !retryFitsShortestWindow(callWindows, state.retryGapMinutes) && (
              <div className="px-3.5 py-2.5 rounded-xl flex items-start gap-2 text-xs bg-amber-500/[0.08] text-amber-200 border border-amber-500/25">
                <Info size={13} className="shrink-0 mt-0.5 text-amber-400" />
                <p className="leading-snug">
                  Your shortest call window{" "}
                  <span className="font-semibold text-amber-100">({minWindowMinutes(callWindows)} min)</span>{" "}
                  is shorter than the {state.retryGapMinutes}-min retry gap — a no-answer won&apos;t get a second
                  attempt before the window closes. Widen the window, or expect just one attempt per window.
                </p>
              </div>
            )}

            {/* Start mode */}
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-[var(--text-2)]">When to start</label>
              <div className="flex gap-2 flex-wrap">
                <StartModeButton
                  active={state.startMode === "now"}
                  onClick={() => setStartMode("now")}
                  icon={<Play size={13} />}
                  label="Immediately"
                />
                <StartModeButton
                  active={state.startMode === "delay"}
                  onClick={() => setStartMode("delay")}
                  icon={<Timer size={13} />}
                  label="In a while"
                />
                <StartModeButton
                  active={state.startMode === "scheduled"}
                  onClick={() => setStartMode("scheduled")}
                  icon={<CalendarDays size={13} />}
                  label="Pick a date"
                />
              </div>
            </div>

            {/* Live mode preview banner — port verbatim from classic */}
            {(() => {
              const isWarn = state.startMode === "scheduled" && !state.scheduledDate;
              return (
                <div
                  className={`px-3.5 py-2.5 rounded-xl flex items-start gap-2 text-xs ${
                    isWarn
                      ? "bg-amber-500/[0.08] text-amber-200 border border-amber-500/25"
                      : "bg-blue-500/[0.06] text-[var(--text-2)] border border-blue-500/20"
                  }`}
                >
                  <Info
                    size={13}
                    className={`shrink-0 mt-0.5 ${isWarn ? "text-amber-400" : "text-blue-400"}`}
                  />
                  {state.startMode === "now" && (() => {
                    const windows = enabledRows.map((r) => ({ day: r.day, start: r.start, end: r.end }));
                    const openNow = isWithinCallWindowAt(windows, state.timezone, Date.now());
                    return openNow ? (
                      <p className="leading-snug">
                        Starts dialing <span className="text-[var(--text-1)] font-semibold">now</span> — the call window is open.
                      </p>
                    ) : (
                      <p className="leading-snug">
                        Starts <span className="text-[var(--text-1)] font-semibold">when the call window opens</span>
                        {enabledRows.length > 0 && (
                          <span className="text-[var(--text-3)]">
                            {" · "}
                            {enabledRows.map((r) => r.day.toUpperCase()).join(", ")} {enabledRows[0].start}–{enabledRows[0].end} · {tzShort}
                          </span>
                        )}
                        .
                      </p>
                    );
                  })()}
                  {state.startMode === "delay" && (
                    <p className="leading-snug">
                      Auto-starts in{" "}
                      <span className="text-[var(--text-1)] font-semibold">{state.delayMinutes} min</span>
                      {" — "}
                      <span className="text-[var(--text-1)] font-semibold">
                        {formatLocalTime(new Date(Date.now() + state.delayMinutes * 60_000), state.timezone)}
                      </span>
                      <span className="text-[var(--text-3)]"> · {tzShort}</span>
                    </p>
                  )}
                  {state.startMode === "scheduled" && state.scheduledDate && (
                    <p className="leading-snug">
                      Auto-starts{" "}
                      <span className="text-[var(--text-1)] font-semibold">
                        {formatLocalTime(new Date(state.scheduledDate), state.timezone)}
                      </span>
                      <span className="text-[var(--text-3)]"> · {tzShort}</span>
                    </p>
                  )}
                  {isWarn && (
                    <p className="leading-snug">
                      Pick a date below — or switch to{" "}
                      <span className="font-semibold">Immediately</span>.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Day-of-week consistency warning.
                See [[project_campaign_day_window_mismatch]] — silent failure
                mode where the dialer logs `outside_call_window` and the
                campaign sits in draft past its visible start time. validateBeforeSubmit
                blocks the SUBMIT; this banner gives the operator a chance to fix
                it without bouncing off the submit button. */}
            {(() => {
              const hasFutureStart =
                state.startMode === "delay"
                || (state.startMode === "scheduled" && Boolean(state.scheduledDate));
              if (!hasFutureStart) return null;

              const effectiveStart =
                state.startMode === "delay"
                  ? new Date(Date.now() + state.delayMinutes * 60_000)
                  : new Date(state.scheduledDate);
              if (Number.isNaN(effectiveStart.getTime())) return null;

              // Intl.DateTimeFormat throws RangeError on malformed timezone.
              // The form-submit validator will surface a friendlier error;
              // here we just suppress the banner so the render doesn't crash.
              let expectedDay: string;
              try {
                expectedDay = dayOfWeekInTimezone(effectiveStart, state.timezone);
              } catch {
                return null;
              }
              const enabledDayKeys = enabledRows.map((r) => r.day);
              const dayEnabled = enabledDayKeys.includes(expectedDay as Day);
              const startRow = enabledRows.find((r) => r.day === expectedDay);
              // Option A live warning: day enabled but the start HOUR is outside that day's window.
              const hourOutside =
                dayEnabled &&
                startRow != null &&
                !isWithinCallWindowAt(
                  [{ day: startRow.day, start: startRow.start, end: startRow.end }],
                  state.timezone,
                  effectiveStart.getTime(),
                );
              if (dayEnabled && !hourOutside) return null; // start lands cleanly inside the window

              const enabledDayLabels = enabledDayKeys.map((d) => d.toUpperCase()).join(", ");
              return (
                <div className="px-3.5 py-2.5 rounded-xl flex items-start gap-2 text-xs bg-amber-500/[0.08] text-amber-200 border border-amber-500/25">
                  <Info size={13} className="shrink-0 mt-0.5 text-amber-400" />
                  {hourOutside && startRow ? (
                    <p className="leading-snug">
                      Start time{" "}
                      <span className="font-semibold text-amber-100">
                        {clockHHMMInTimezone(effectiveStart.getTime(), state.timezone)}
                      </span>{" "}
                      on <span className="font-semibold text-amber-100">{expectedDay.toUpperCase()}</span>{" "}
                      <span className="text-amber-300/70">({tzShort})</span>{" "}
                      is outside that day&apos;s window{" "}
                      <span className="font-semibold text-amber-100">{startRow.start}–{startRow.end}</span>
                      {" — move the start in, or widen the window, otherwise calls won't fire then."}
                    </p>
                  ) : (
                    <p className="leading-snug">
                      Start time falls on{" "}
                      <span className="font-semibold text-amber-100">{expectedDay.toUpperCase()}</span>{" "}
                      <span className="text-amber-300/70">({tzShort})</span>{" — "}
                      {enabledDayKeys.length === 0
                        ? "no days are enabled above."
                        : (
                            <>
                              only{" "}
                              <span className="font-semibold text-amber-100">{enabledDayLabels}</span>{" "}
                              {enabledDayKeys.length === 1 ? "is" : "are"} enabled.
                            </>
                          )}
                      {" "}
                      Toggle{" "}
                      <span className="font-semibold text-amber-100">{expectedDay.toUpperCase()}</span>{" "}
                      on, or change the start time — otherwise calls won&apos;t fire.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Delay presets */}
            {state.startMode === "delay" && (
              <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4">
                <p className="text-xs text-[var(--text-3)] mb-3">Start dialling after:</p>
                <div className="flex flex-wrap gap-2">
                  {DELAY_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setDelayMinutes(p.value)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                        state.delayMinutes === p.value
                          ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                          : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30 hover:text-blue-400"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Scheduled date picker */}
            {state.startMode === "scheduled" && (
              <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4">
                <p className="text-xs text-[var(--text-3)] mb-2">
                  Pick a date and time. Times are in your browser&apos;s timezone (
                  {Intl.DateTimeFormat().resolvedOptions().timeZone}).
                </p>
                <DateTimePickerField
                  value={state.scheduledDate}
                  onChange={(v) => setScheduledDate(v)}
                  min={new Date().toISOString().slice(0, 16)}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function ChoiceTile({
  active, onClick, icon, name, description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  name: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative text-left p-[18px] rounded-2xl border-[1.5px] transition-all ${
        active
          ? "border-blue-500 bg-blue-500/[0.08]"
          : "border-[var(--border)] bg-[var(--bg-app)] hover:border-[var(--border-2)] hover:bg-[var(--bg-card)]"
      }`}
    >
      <div className="flex items-center gap-2.5 mb-1.5">
        <div
          className={`w-8 h-8 rounded-lg grid place-items-center transition ${
            active ? "bg-blue-500 text-white" : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
          }`}
        >
          {icon}
        </div>
        <span className="text-sm font-semibold text-[var(--text-1)]">{name}</span>
      </div>
      <p className="text-xs text-[var(--text-3)] leading-snug">{description}</p>
    </button>
  );
}

function StartModeButton({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-medium transition ${
        active
          ? "bg-blue-500 text-white shadow-md shadow-blue-500/20"
          : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/40 hover:text-[var(--text-1)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
