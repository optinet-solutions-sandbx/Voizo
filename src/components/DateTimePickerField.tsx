// src/app/campaigns/v2/new/components/DateTimePickerField.tsx
//
// Combined date + time popover for the "Pick a date" start mode. Visual
// pattern lifted from the handoff prototype
// (voizo-handoff/src/app/campaigns/v2/new/DateTimePicker.tsx) — month grid
// on the left, time controls (large display + hour/min steppers + AM/PM
// tabs) on the right.
//
// Adapter: outside `value: string` is "YYYY-MM-DDTHH:MM" (the same
// datetime-local ISO format the classic form's submit flow expects via
// `new Date(scheduledDate).toISOString()`). Internally the popover works
// in {date, hour 1-12, min, ampm}.
//
// Past-date blocking: pass `min` (also "YYYY-MM-DDTHH:MM"). Days before
// the min day get visually muted + clicks are NOOPs. Schedule button is
// disabled when the picked datetime falls before `min`.

"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  /** "YYYY-MM-DDTHH:MM" 24-hour. Empty string = unset. */
  value: string;
  /** Fires with "YYYY-MM-DDTHH:MM" 24-hour when operator clicks Schedule. */
  onChange: (value: string) => void;
  /** Optional minimum "YYYY-MM-DDTHH:MM"; days before get disabled. */
  min?: string;
  placeholder?: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function daysInMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
function dayKey(d: Date): number {
  // Numeric YYYYMMDD key for cheap date-only comparisons (ignores time).
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

interface ParsedDT {
  date: Date;
  hour: number; // 1-12 (display)
  min: number;
  ampm: "AM" | "PM";
}

function parseIso(v: string): ParsedDT | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3]);
  const h24 = Math.min(23, Math.max(0, +m[4]));
  const min = Math.min(59, Math.max(0, +m[5]));
  const ampm: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  let hour = h24 % 12;
  if (hour === 0) hour = 12;
  return { date, hour, min, ampm };
}

function fmtIso(date: Date, hour: number, min: number, ampm: "AM" | "PM"): string {
  let h24 = hour % 12;
  if (ampm === "PM") h24 += 12;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(h24).padStart(2, "0");
  const mm = String(min).padStart(2, "0");
  return `${y}-${mo}-${d}T${hh}:${mm}`;
}

function fmtLabel(p: ParsedDT): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][p.date.getDay()];
  return `${weekday} ${MONTHS[p.date.getMonth()]} ${p.date.getDate()} · ${p.hour}:${String(p.min).padStart(2, "0")} ${p.ampm}`;
}

export default function DateTimePickerField({
  value,
  onChange,
  min,
  placeholder = "Pick a date",
}: Props) {
  const today = new Date();
  const parsed = parseIso(value);
  const minParsed = min ? parseIso(min) : null;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(parsed?.date ?? today);
  const [selected, setSelected] = useState<Date>(parsed?.date ?? today);
  const [hour, setHour] = useState(parsed?.hour ?? 9);
  const [mins, setMins] = useState(parsed?.min ?? 0);
  const [ampm, setAmpm] = useState<"AM" | "PM">(parsed?.ampm ?? "AM");

  const wrap = useRef<HTMLDivElement>(null);

  // Re-sync internal state when prop changes from outside, but only while
  // closed so we don't clobber an in-flight pick. Legitimate "sync
  // internal state to an external prop" case — see TimePickerField for
  // the same pattern + explanation. React-19's set-state-in-effect rule
  // is over-eager for picker popovers that own mid-edit state.
  useEffect(() => {
    if (open) return;
    const p = parseIso(value);
    if (p) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setView(p.date);
      setSelected(p.date);
      setHour(p.hour);
      setMins(p.min);
      setAmpm(p.ampm);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Past-date blocking — compute candidate ISO and compare against min as
  // strings (lex order matches chronological for "YYYY-MM-DDTHH:MM").
  const candidateIso = fmtIso(selected, hour, mins, ampm);
  const isBeforeMin = min ? candidateIso < min : false;

  function commit() {
    if (isBeforeMin) return;
    onChange(candidateIso);
    setOpen(false);
  }

  // ── Calendar grid for the `view` month ──
  const monthStart = startOfMonth(view);
  const offset = monthStart.getDay();
  const days = daysInMonth(view);
  const prevDays = daysInMonth(new Date(view.getFullYear(), view.getMonth() - 1, 1));
  const cells: { d: number; out: boolean; date: Date }[] = [];
  for (let i = offset - 1; i >= 0; i--) {
    cells.push({
      d: prevDays - i,
      out: true,
      date: new Date(view.getFullYear(), view.getMonth() - 1, prevDays - i),
    });
  }
  for (let d = 1; d <= days; d++) {
    cells.push({ d, out: false, date: new Date(view.getFullYear(), view.getMonth(), d) });
  }
  const trail = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= trail; i++) {
    cells.push({ d: i, out: true, date: new Date(view.getFullYear(), view.getMonth() + 1, i) });
  }

  const minDayKey = minParsed ? dayKey(minParsed.date) : null;

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border-[1.5px] text-sm font-medium transition ${
          open
            ? "border-blue-500 ring-[3px] ring-blue-500/20 text-[var(--text-1)]"
            : "border-[var(--border)] hover:border-[var(--border-2)]"
        } ${parsed ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}`}
      >
        <Calendar size={14} className="text-[var(--text-3)]" />
        <span className="flex-1 text-left font-mono">{parsed ? fmtLabel(parsed) : placeholder}</span>
        <ChevronDown
          size={13}
          className={`text-[var(--text-3)] transition ${open ? "rotate-180 text-blue-400" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 min-w-[520px] bg-[var(--bg-card)] border border-[var(--border-2)] rounded-2xl shadow-2xl p-4">
          <div className="grid grid-cols-[1fr_200px] gap-5">
            {/* Calendar (left) */}
            <div>
              <div className="flex items-center justify-between mb-2.5">
                <div className="text-sm font-semibold text-[var(--text-1)] px-2 py-1.5">
                  {MONTHS[view.getMonth()]} {view.getFullYear()}
                </div>
                <div className="flex gap-0.5">
                  <button
                    type="button"
                    onClick={() =>
                      setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))
                    }
                    className="w-7 h-7 rounded-md grid place-items-center text-[var(--text-3)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition"
                  >
                    <ChevronLeft size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))
                    }
                    className="w-7 h-7 rounded-md grid place-items-center text-[var(--text-3)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition"
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-0.5 mb-1">
                {WEEKDAYS.map((d, i) => (
                  <div
                    key={i}
                    className="text-center text-[10px] font-semibold text-[var(--text-3)] py-1.5 font-mono"
                  >
                    {d}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-7 gap-0.5">
                {cells.map((c, i) => {
                  const isToday = sameDay(c.date, today);
                  const isSelected = sameDay(c.date, selected);
                  const disabled = minDayKey !== null && dayKey(c.date) < minDayKey;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => {
                        if (disabled) return;
                        setSelected(c.date);
                      }}
                      disabled={disabled}
                      className={`aspect-square rounded-lg font-mono text-[12.5px] transition relative ${
                        disabled
                          ? "opacity-25 cursor-not-allowed text-[var(--text-3)]"
                          : c.out
                            ? "opacity-30 text-[var(--text-2)] hover:bg-[var(--bg-elevated)]"
                            : isSelected
                              ? "bg-blue-500 text-white font-semibold"
                              : isToday
                                ? "text-blue-400 font-bold hover:bg-[var(--bg-elevated)]"
                                : "text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)]"
                      }`}
                    >
                      {c.d}
                      {isToday && !isSelected && !disabled && (
                        <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-[3px] h-[3px] rounded-full bg-blue-400" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Time controls (right) */}
            <div className="flex flex-col gap-2.5 border-l border-[var(--border)] pl-5">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-3)]">
                Time
              </span>
              <div className="font-mono text-[28px] font-bold tracking-tight text-center py-1.5">
                <span>{String(hour).padStart(2, "0")}</span>
                <span className="text-[var(--text-3)] font-normal">:</span>
                <span>{String(mins).padStart(2, "0")}</span>
                <span className="text-[13px] font-sans text-[var(--text-3)] ml-1.5">{ampm}</span>
              </div>

              <Stepper
                label="Hour"
                value={hour}
                onMinus={() => setHour(((hour - 2 + 12) % 12) + 1)}
                onPlus={() => setHour((hour % 12) + 1)}
              />
              <Stepper
                label="Min"
                value={String(mins).padStart(2, "0")}
                onMinus={() => setMins((mins + 45) % 60)}
                onPlus={() => setMins((mins + 15) % 60)}
              />

              <div className="flex gap-1.5 mt-auto p-0.5 bg-[var(--bg-app)] rounded-lg">
                {(["AM", "PM"] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmpm(a)}
                    className={`flex-1 py-2 rounded-md text-xs font-semibold transition ${
                      ampm === a
                        ? "bg-[var(--bg-card)] text-[var(--text-1)] shadow-sm"
                        : "text-[var(--text-3)] hover:text-[var(--text-1)]"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {isBeforeMin && (
            <p className="text-xs text-amber-300 mt-3 -mb-1 px-1">
              Selected time is in the past. Pick a later date or time.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-3 mt-3 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-2)] text-xs font-semibold hover:border-[var(--border-2)] hover:text-[var(--text-1)] transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={isBeforeMin}
              className="px-4 py-1.5 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-400 transition shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-blue-500 disabled:shadow-none"
            >
              Schedule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stepper({
  label,
  value,
  onMinus,
  onPlus,
}: {
  label: string;
  value: string | number;
  onMinus: () => void;
  onPlus: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-[var(--text-3)] w-9 uppercase tracking-wide">{label}</span>
      <div className="flex-1 grid grid-cols-[1fr_auto_1fr] gap-1">
        <button
          type="button"
          onClick={onMinus}
          className="py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500 hover:text-blue-400 transition grid place-items-center"
        >
          <ChevronLeft size={11} />
        </button>
        <span className="px-2 py-1.5 text-center font-mono text-[13px] font-semibold min-w-[36px]">
          {value}
        </span>
        <button
          type="button"
          onClick={onPlus}
          className="py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500 hover:text-blue-400 transition grid place-items-center"
        >
          <ChevronRight size={11} />
        </button>
      </div>
    </div>
  );
}
