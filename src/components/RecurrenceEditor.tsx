"use client";

import { useState } from "react";
import {
  CalendarDays,
  Clock,
  Hash,
  Infinity as InfinityIcon,
  Plus,
  Repeat,
  X,
  AlertCircle,
} from "lucide-react";
import type { DayOfWeek, RecurrencePattern, RecurrenceEndKind } from "@/lib/types/recurrence";

const DAYS: Array<{ key: DayOfWeek; label: string }> = [
  { key: "sun", label: "Sunday" },
  { key: "mon", label: "Monday" },
  { key: "tue", label: "Tuesday" },
  { key: "wed", label: "Wednesday" },
  { key: "thu", label: "Thursday" },
  { key: "fri", label: "Friday" },
  { key: "sat", label: "Saturday" },
];

const DEFAULT_HOURS = { start: "09:00", end: "21:00" };

export interface RecurrenceEditorProps {
  value: RecurrencePattern;
  onChange: (next: RecurrencePattern) => void;
  campaignTimezone: string;
  segmentName?: string;
  errors?: string[];
}

export function defaultRecurrencePattern(today: Date, _timezone: string): RecurrencePattern {
  const todayStr = today.toISOString().slice(0, 10);
  return {
    start_date: todayStr,
    end_kind: "never",
    end_date: null,
    end_after_n: null,
    repeat_every_weeks: 1,
    days_of_week: ["mon", "wed", "fri"],
    call_hours_by_day: {
      mon: { ...DEFAULT_HOURS },
      wed: { ...DEFAULT_HOURS },
      fri: { ...DEFAULT_HOURS },
    },
    exception_dates: [],
    skip_if_empty: true,
    segment_refresh_time: "08:30",
    spawned_count: 0,
  };
}

export function RecurrenceEditor({
  value,
  onChange,
  campaignTimezone,
  segmentName,
  errors,
}: RecurrenceEditorProps) {
  const [sameHours, setSameHours] = useState<boolean>(() => {
    const hoursList = value.days_of_week
      .map((d) => value.call_hours_by_day[d])
      .filter((h): h is { start: string; end: string } => Boolean(h));
    if (hoursList.length <= 1) return true;
    const first = hoursList[0];
    return hoursList.every((h) => h.start === first.start && h.end === first.end);
  });
  const [pendingException, setPendingException] = useState<string>("");

  const update = (patch: Partial<RecurrencePattern>) => onChange({ ...value, ...patch });

  const toggleDay = (day: DayOfWeek) => {
    const isOn = value.days_of_week.includes(day);
    const nextDays: DayOfWeek[] = isOn
      ? value.days_of_week.filter((d) => d !== day)
      : DAYS.map((d) => d.key).filter((d) => value.days_of_week.includes(d) || d === day);
    const nextHours = { ...value.call_hours_by_day };
    if (isOn) {
      delete nextHours[day];
    } else {
      const firstExisting = value.days_of_week
        .map((d) => value.call_hours_by_day[d])
        .find((h): h is { start: string; end: string } => Boolean(h));
      nextHours[day] = firstExisting ? { ...firstExisting } : { ...DEFAULT_HOURS };
    }
    update({ days_of_week: nextDays, call_hours_by_day: nextHours });
  };

  const updateDayHours = (day: DayOfWeek, patch: Partial<{ start: string; end: string }>) => {
    const current = value.call_hours_by_day[day] ?? { ...DEFAULT_HOURS };
    update({
      call_hours_by_day: {
        ...value.call_hours_by_day,
        [day]: { ...current, ...patch },
      },
    });
  };

  const updateAllDayHours = (patch: Partial<{ start: string; end: string }>) => {
    const nextHours: RecurrencePattern["call_hours_by_day"] = {};
    for (const day of value.days_of_week) {
      const current = value.call_hours_by_day[day] ?? { ...DEFAULT_HOURS };
      nextHours[day] = { ...current, ...patch };
    }
    update({ call_hours_by_day: nextHours });
  };

  const handleSameHoursToggle = (next: boolean) => {
    setSameHours(next);
    if (next) {
      const firstHours =
        value.days_of_week
          .map((d) => value.call_hours_by_day[d])
          .find((h): h is { start: string; end: string } => Boolean(h)) ?? { ...DEFAULT_HOURS };
      const unified: RecurrencePattern["call_hours_by_day"] = {};
      for (const day of value.days_of_week) {
        unified[day] = { ...firstHours };
      }
      update({ call_hours_by_day: unified });
    }
  };

  const addException = () => {
    if (!pendingException || !/^\d{4}-\d{2}-\d{2}$/.test(pendingException)) return;
    if (value.exception_dates.includes(pendingException)) {
      setPendingException("");
      return;
    }
    update({ exception_dates: [...value.exception_dates, pendingException].sort() });
    setPendingException("");
  };

  const removeException = (d: string) => {
    update({ exception_dates: value.exception_dates.filter((x) => x !== d) });
  };

  const handleEndKindChange = (kind: RecurrenceEndKind) => {
    const patch: Partial<RecurrencePattern> = { end_kind: kind };
    if (kind !== "on_date") patch.end_date = null;
    if (kind !== "after_n") patch.end_after_n = null;
    if (kind === "after_n" && value.end_after_n == null) patch.end_after_n = 10;
    update(patch);
  };

  const sharedHours = (() => {
    const first = value.days_of_week
      .map((d) => value.call_hours_by_day[d])
      .find((h): h is { start: string; end: string } => Boolean(h));
    return first ?? { ...DEFAULT_HOURS };
  })();

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
      <div className="flex items-center gap-2">
        <Repeat size={16} className="text-blue-400" />
        <h2 className="text-base font-semibold text-[var(--text-1)]">Recurring Schedule</h2>
      </div>
      {segmentName && (
        <p className="text-xs text-[var(--text-3)] -mt-3">
          Daily children will dial the latest members of segment{" "}
          <span className="text-[var(--text-2)] font-medium">{segmentName}</span>.
        </p>
      )}

      {/* ── Start date ───────────────────────────────────────────────── */}
      <div>
        <FieldLabel icon={<CalendarDays size={14} />}>Start date</FieldLabel>
        <input
          type="date"
          value={value.start_date}
          onChange={(e) => update({ start_date: e.target.value })}
          className="px-3 py-2 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {/* ── End condition ────────────────────────────────────────────── */}
      <div>
        <FieldLabel icon={<InfinityIcon size={14} />}>End</FieldLabel>
        <div className="space-y-2">
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="radio"
              name="recurrence-end"
              checked={value.end_kind === "never"}
              onChange={() => handleEndKindChange("never")}
              className="accent-blue-500"
            />
            <span className="text-sm text-[var(--text-1)]">Never</span>
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="radio"
              name="recurrence-end"
              checked={value.end_kind === "on_date"}
              onChange={() => handleEndKindChange("on_date")}
              className="accent-blue-500"
            />
            <span className="text-sm text-[var(--text-1)]">On</span>
            {value.end_kind === "on_date" && (
              <input
                type="date"
                value={value.end_date ?? ""}
                min={value.start_date}
                onChange={(e) => update({ end_date: e.target.value || null })}
                className="ml-2 px-3 py-1.5 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            )}
          </label>
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="radio"
              name="recurrence-end"
              checked={value.end_kind === "after_n"}
              onChange={() => handleEndKindChange("after_n")}
              className="accent-blue-500"
            />
            <span className="text-sm text-[var(--text-1)]">After</span>
            {value.end_kind === "after_n" && (
              <>
                <input
                  type="number"
                  min={1}
                  value={value.end_after_n ?? ""}
                  onChange={(e) =>
                    update({ end_after_n: e.target.value ? parseInt(e.target.value, 10) : null })
                  }
                  className="ml-2 w-20 px-3 py-1.5 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <span className="text-sm text-[var(--text-3)]">occurrences</span>
              </>
            )}
          </label>
        </div>
      </div>

      {/* ── Repeat every N weeks (locked to 1 in Phase 1) ───────────── */}
      <div>
        <FieldLabel icon={<Hash size={14} />}>Repeat every</FieldLabel>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={value.repeat_every_weeks}
            disabled
            title="Phase 1 only supports weekly recurrence (every 1 week)."
            onChange={(e) =>
              update({ repeat_every_weeks: Math.max(1, parseInt(e.target.value || "1", 10)) })
            }
            className="w-20 px-3 py-1.5 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-3)] cursor-not-allowed focus:outline-none"
          />
          <span className="text-sm text-[var(--text-3)]">week (Phase 1 only supports weekly)</span>
        </div>
      </div>

      {/* ── Days of week ────────────────────────────────────────────── */}
      <div>
        <FieldLabel icon={<CalendarDays size={14} />}>On days</FieldLabel>
        <p className="text-xs text-[var(--text-3)] -mt-1.5 mb-2">
          Pick which days a daily child campaign should spawn.
        </p>
        <div className="flex flex-wrap gap-2">
          {DAYS.map(({ key, label }) => {
            const on = value.days_of_week.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleDay(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  on
                    ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                    : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-3)] hover:border-blue-500/30"
                }`}
              >
                {label.slice(0, 3)}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Call hours ──────────────────────────────────────────────── */}
      <div>
        <FieldLabel icon={<Clock size={14} />}>Call hours</FieldLabel>
        <div className="flex gap-3 mb-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="recurrence-same-hours"
              checked={sameHours}
              onChange={() => handleSameHoursToggle(true)}
              className="accent-blue-500"
            />
            <span className="text-sm text-[var(--text-2)]">Same for all days</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="recurrence-same-hours"
              checked={!sameHours}
              onChange={() => handleSameHoursToggle(false)}
              className="accent-blue-500"
            />
            <span className="text-sm text-[var(--text-2)]">Different per day</span>
          </label>
        </div>

        {value.days_of_week.length === 0 ? (
          <p className="text-xs text-[var(--text-3)]">Select at least one day to set call hours.</p>
        ) : sameHours ? (
          <div className="flex items-center gap-2 bg-[var(--bg-app)] border border-[var(--border)] rounded-xl px-3 py-2">
            <input
              type="time"
              value={sharedHours.start}
              onChange={(e) => updateAllDayHours({ start: e.target.value })}
              className="px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <span className="text-xs text-[var(--text-3)]">to</span>
            <input
              type="time"
              value={sharedHours.end}
              onChange={(e) => updateAllDayHours({ end: e.target.value })}
              className="px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] divide-y divide-[var(--border)]">
            {DAYS.filter((d) => value.days_of_week.includes(d.key)).map(({ key, label }) => {
              const hours = value.call_hours_by_day[key] ?? { ...DEFAULT_HOURS };
              return (
                <div key={key} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="text-sm font-medium text-[var(--text-1)] min-w-[5rem]">
                    {label}
                  </span>
                  <div className="flex items-center gap-2 flex-1">
                    <input
                      type="time"
                      value={hours.start}
                      onChange={(e) => updateDayHours(key, { start: e.target.value })}
                      className="px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <span className="text-xs text-[var(--text-3)]">to</span>
                    <input
                      type="time"
                      value={hours.end}
                      onChange={(e) => updateDayHours(key, { end: e.target.value })}
                      className="px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="text-xs text-[var(--text-3)] mt-2">
          Calls only dial during these hours, in {campaignTimezone}.
        </p>
      </div>

      {/* ── Exception dates ─────────────────────────────────────────── */}
      <div>
        <FieldLabel icon={<X size={14} />}>Exception dates</FieldLabel>
        <p className="text-xs text-[var(--text-3)] -mt-1.5 mb-2">
          Skip these specific dates (holidays, blackouts, etc.).
        </p>
        <div className="flex items-center gap-2 mb-2">
          <input
            type="date"
            value={pendingException}
            min={value.start_date}
            onChange={(e) => setPendingException(e.target.value)}
            className="px-3 py-1.5 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="button"
            onClick={addException}
            disabled={!pendingException}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/20 text-blue-400 border border-blue-500/30 hover:bg-blue-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus size={12} />
            Add date
          </button>
        </div>
        {value.exception_dates.length > 0 && (
          <ul className="space-y-1.5">
            {value.exception_dates.map((d) => (
              <li
                key={d}
                className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-[var(--bg-app)] border border-[var(--border)]"
              >
                <span className="text-sm text-[var(--text-1)] font-mono">{d}</span>
                <button
                  type="button"
                  onClick={() => removeException(d)}
                  className="p-1 rounded text-[var(--text-3)] hover:text-red-400 hover:bg-red-500/10"
                  aria-label={`Remove ${d}`}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Skip-if-empty ───────────────────────────────────────────── */}
      <div>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={value.skip_if_empty}
            onChange={(e) => update({ skip_if_empty: e.target.checked })}
            className="mt-0.5 accent-blue-500"
          />
          <span className="text-sm text-[var(--text-1)]">
            Skip days when the segment is empty
            <span className="block text-xs text-[var(--text-3)] mt-0.5">
              When on, days with zero matching customers record a skipped row and don&apos;t lease
              a worker. When off, the spawn fails the day with no row.
            </span>
          </span>
        </label>
      </div>

      {/* ── Segment refresh time ────────────────────────────────────── */}
      <div>
        <FieldLabel icon={<Clock size={14} />}>Segment refresh time</FieldLabel>
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={value.segment_refresh_time}
            onChange={(e) => update({ segment_refresh_time: e.target.value })}
            className="px-3 py-1.5 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-xs text-[var(--text-3)]">in {campaignTimezone}</span>
        </div>
        <p className="text-xs text-[var(--text-3)] mt-1.5">
          Each scheduled day, the child campaign spawns at-or-after this clock time and pulls a
          fresh customer.io segment snapshot.
        </p>
      </div>

      {/* ── Errors ──────────────────────────────────────────────────── */}
      {errors && errors.length > 0 && (
        <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-red-400 mt-0.5 shrink-0" />
            <ul className="text-xs text-red-300 space-y-1">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

function FieldLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)] mb-1.5 uppercase tracking-wide">
      {icon}
      {children}
    </label>
  );
}
