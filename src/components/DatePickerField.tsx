// src/components/DatePickerField.tsx
//
// Date-only picker — month grid popover styled to match TimePickerField
// + DateTimePickerField. Used by RecurrenceEditor for start_date,
// end_date, and exception dates (no time component).
//
// Adapter: outside `value: string` is "YYYY-MM-DD". Empty string = unset.

"use client";

import { useEffect, useRef, useState } from "react";
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  /** "YYYY-MM-DD". Empty string = unset. */
  value: string;
  /** Fires with "YYYY-MM-DD" when the operator clicks Select. */
  onChange: (value: string) => void;
  /** Optional "YYYY-MM-DD" minimum date; days before get disabled. */
  min?: string;
  placeholder?: string;
  /** Optional aria-label / title for accessibility. */
  ariaLabel?: string;
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
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function parseYmd(v: string): Date | null {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function fmtYmd(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function fmtLabel(d: Date): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${weekday} ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export default function DatePickerField({
  value,
  onChange,
  min,
  placeholder = "Pick a date",
  ariaLabel,
}: Props) {
  const today = new Date();
  const parsed = parseYmd(value);
  const minParsed = min ? parseYmd(min) : null;

  const [open, setOpen] = useState(false);
  const [view, setView] = useState<Date>(parsed ?? today);
  const [selected, setSelected] = useState<Date | null>(parsed);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) return;
    setSelected(parseYmd(value));
    setView(parseYmd(value) ?? today);
    // We intentionally read `value` for the latest external value, but the
    // ESLint deps line gets unhappy about `today`. `today` is recreated each
    // render but used only as a fallback; harmless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function commit() {
    if (!selected) return;
    onChange(fmtYmd(selected));
    setOpen(false);
  }
  function clear() {
    setSelected(null);
    onChange("");
    setOpen(false);
  }

  // Calendar cells
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

  const minDayKey = minParsed ? dayKey(minParsed) : null;

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={ariaLabel ?? "Pick a date"}
        className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-app)] border-[1.5px] text-sm font-mono transition ${
          open
            ? "border-blue-500 ring-[3px] ring-blue-500/20 text-[var(--text-1)]"
            : "border-[var(--border)] hover:border-[var(--border-2)]"
        } ${parsed ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}`}
      >
        <Calendar size={13} className="text-[var(--text-3)]" />
        <span>{parsed ? fmtYmd(parsed) : placeholder}</span>
        <ChevronDown
          size={11}
          className={`text-[var(--text-3)] transition ${open ? "rotate-180 text-blue-400" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-50 bg-[var(--bg-card)] border border-[var(--border-2)] rounded-2xl shadow-2xl p-4 w-[280px]">
          <div className="flex items-center justify-between mb-2.5">
            <div className="text-sm font-semibold text-[var(--text-1)] px-2 py-1.5">
              {MONTHS[view.getMonth()]} {view.getFullYear()}
            </div>
            <div className="flex gap-0.5">
              <button
                type="button"
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
                className="w-7 h-7 rounded-md grid place-items-center text-[var(--text-3)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition"
              >
                <ChevronLeft size={13} />
              </button>
              <button
                type="button"
                onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
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
              const isSelected = selected ? sameDay(c.date, selected) : false;
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

          {selected && (
            <p className="text-[11px] text-[var(--text-3)] mt-3 text-center font-mono">
              {fmtLabel(selected)}
            </p>
          )}

          <div className="flex justify-between gap-2 pt-3 mt-3 border-t border-[var(--border)]">
            <button
              type="button"
              onClick={clear}
              className="text-xs text-[var(--text-3)] hover:text-red-400 font-medium"
            >
              Clear
            </button>
            <div className="flex gap-2">
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
                disabled={!selected}
                className="px-4 py-1.5 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-400 transition shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-blue-500 disabled:shadow-none"
              >
                Select
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
