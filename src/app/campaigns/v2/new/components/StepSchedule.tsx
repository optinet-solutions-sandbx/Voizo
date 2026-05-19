"use client";

import { useMemo, type Dispatch } from "react";
import {
  CalendarDays, Globe2, Info, Play, Repeat, Timer,
} from "lucide-react";

import { RecurrenceEditor } from "@/components/RecurrenceEditor";

import {
  DAYS, getCallingHours, TIMEZONE_OPTIONS,
  type Day, type ScheduleRow, type WizardAction, type WizardState,
} from "../wizardState";
import TimePickerField from "@/components/TimePickerField";
import DateTimePickerField from "@/components/DateTimePickerField";
import StyledSelect from "@/components/StyledSelect";

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
  function setCampaignType(next: "fixed" | "recurring") {
    dispatch({ type: "SET_SCHEDULE_FIELDS", payload: { campaignType: next } });
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

  const enabledRows = useMemo(
    () => state.scheduleRows.filter((r) => r.enabled),
    [state.scheduleRows],
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <ChoiceTile
            active={!isRecurring}
            onClick={() => setCampaignType("fixed")}
            icon={<Play size={14} />}
            name="Run once"
            description="Dial through this list once, then stop. Best for promos and tests."
          />
          <ChoiceTile
            active={isRecurring}
            onClick={() => setCampaignType("recurring")}
            icon={<Repeat size={14} />}
            name="Repeat daily"
            description="Auto-spawn a fresh child each scheduled day with the latest segment."
          />
        </div>

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
                  {state.startMode === "now" && (
                    <p className="leading-snug">
                      Saves as <span className="text-[var(--text-1)] font-semibold">draft</span> — click{" "}
                      <span className="text-emerald-400 font-semibold">Start</span> on the campaign page to begin.
                    </p>
                  )}
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
