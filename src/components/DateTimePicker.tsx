"use client";

import { useState, useMemo } from "react";
import { ChevronLeft, ChevronRight, Clock } from "lucide-react";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_HEADERS = ["S", "M", "T", "W", "T", "F", "S"];

interface Props {
  /** Value in "YYYY-MM-DDTHH:mm" format (same as datetime-local) */
  value: string;
  /** Fires with "YYYY-MM-DDTHH:mm" when user clicks Select */
  onChange: (value: string) => void;
  /** Min date in "YYYY-MM-DDTHH:mm" format — days before this are disabled */
  min?: string;
}

interface CalendarCell {
  day: number;
  month: number;
  year: number;
  currentMonth: boolean;
}

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

export default function DateTimePicker({ value, onChange, min }: Props) {
  const now = new Date();
  const minDate = min ? new Date(min) : null;
  const initDate = value ? new Date(value) : null;

  // ── Calendar view navigation ──
  const [viewYear, setViewYear] = useState(initDate?.getFullYear() ?? now.getFullYear());
  const [viewMonth, setViewMonth] = useState(initDate?.getMonth() ?? now.getMonth());

  // ── Selected date ──
  const [selYear, setSelYear] = useState<number | null>(initDate?.getFullYear() ?? null);
  const [selMonth, setSelMonth] = useState<number | null>(initDate?.getMonth() ?? null);
  const [selDay, setSelDay] = useState<number | null>(initDate?.getDate() ?? null);

  // ── Time ──
  const [hour, setHour] = useState<number>(() => {
    if (initDate) {
      const h = initDate.getHours();
      return h === 0 ? 12 : h > 12 ? h - 12 : h;
    }
    return 9;
  });
  const [minute, setMinute] = useState<number>(initDate?.getMinutes() ?? 0);
  const [ampm, setAmpm] = useState<"AM" | "PM">(() => {
    if (initDate) return initDate.getHours() >= 12 ? "PM" : "AM";
    return "AM";
  });

  // ── Calendar grid ──
  const calendarCells = useMemo<CalendarCell[]>(() => {
    const firstDow = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrev = new Date(viewYear, viewMonth, 0).getDate();

    const cells: CalendarCell[] = [];

    // Previous-month tail
    for (let i = firstDow - 1; i >= 0; i--) {
      const pm = viewMonth === 0 ? 11 : viewMonth - 1;
      const py = viewMonth === 0 ? viewYear - 1 : viewYear;
      cells.push({ day: daysInPrev - i, month: pm, year: py, currentMonth: false });
    }

    // Current month
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ day: d, month: viewMonth, year: viewYear, currentMonth: true });
    }

    // Next-month head (fill to complete last row)
    const totalCells = Math.ceil(cells.length / 7) * 7;
    let nd = 1;
    while (cells.length < totalCells) {
      const nm = viewMonth === 11 ? 0 : viewMonth + 1;
      const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
      cells.push({ day: nd++, month: nm, year: ny, currentMonth: false });
    }

    return cells;
  }, [viewYear, viewMonth]);

  // ── Helpers ──
  function isDayDisabled(day: number, month: number, year: number) {
    if (!minDate) return false;
    const d = new Date(year, month, day, 23, 59, 59);
    const minDay = new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate(), 0, 0, 0);
    return d < minDay;
  }

  function isToday(day: number, month: number, year: number) {
    return day === now.getDate() && month === now.getMonth() && year === now.getFullYear();
  }

  function isSelected(day: number, month: number, year: number) {
    return day === selDay && month === selMonth && year === selYear;
  }

  // ── Actions ──
  function handleDayClick(cell: CalendarCell) {
    if (isDayDisabled(cell.day, cell.month, cell.year)) return;
    setSelDay(cell.day);
    setSelMonth(cell.month);
    setSelYear(cell.year);
    if (cell.month !== viewMonth || cell.year !== viewYear) {
      setViewMonth(cell.month);
      setViewYear(cell.year);
    }
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  }

  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  }

  // Build the full datetime from current selection (null if no day picked)
  const selectedDateTime = useMemo(() => {
    if (selDay === null || selMonth === null || selYear === null) return null;
    const h24 = ampm === "AM" ? (hour === 12 ? 0 : hour) : (hour === 12 ? 12 : hour + 12);
    return new Date(selYear, selMonth, selDay, h24, minute);
  }, [selDay, selMonth, selYear, hour, minute, ampm]);

  const isInPast = selectedDateTime ? selectedDateTime.getTime() <= now.getTime() : false;

  function handleSelect() {
    if (selDay === null || selMonth === null || selYear === null) return;
    const h24 = ampm === "AM" ? (hour === 12 ? 0 : hour) : (hour === 12 ? 12 : hour + 12);
    // Fresh check at click-time — `now` from render may be stale if the
    // operator sat idle for a few minutes after picking the time.
    const clickNow = new Date();
    const built = new Date(selYear, selMonth, selDay, h24, minute);
    if (built.getTime() <= clickNow.getTime()) return;
    const dateStr = `${selYear}-${pad2(selMonth + 1)}-${pad2(selDay)}T${pad2(h24)}:${pad2(minute)}`;
    onChange(dateStr);
  }

  const hasSelection = selDay !== null;

  // ── Can we go to previous month? Block navigating before min-date month ──
  const canGoPrev = (() => {
    if (!minDate) return true;
    const prevM = viewMonth === 0 ? 11 : viewMonth - 1;
    const prevY = viewMonth === 0 ? viewYear - 1 : viewYear;
    const lastOfPrev = new Date(prevY, prevM + 1, 0);
    return lastOfPrev >= new Date(minDate.getFullYear(), minDate.getMonth(), 1);
  })();

  const selectClass =
    "appearance-none bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 cursor-pointer";

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden select-none w-fit">
      {/* ── Month / Year header ── */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          onClick={prevMonth}
          disabled={!canGoPrev}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="text-sm font-semibold text-[var(--text-1)]">
          {MONTH_NAMES[viewMonth]} {viewYear}
        </span>
        <button
          type="button"
          onClick={nextMonth}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] transition-colors"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* ── Day-of-week labels ── */}
      <div className="grid grid-cols-7 gap-1 px-3">
        {DAY_HEADERS.map((label, i) => (
          <div key={i} className="w-8 text-center text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] py-1">
            {label}
          </div>
        ))}
      </div>

      {/* ── Day grid ── */}
      <div className="grid grid-cols-7 gap-1 px-3 pb-3">
        {calendarCells.map((cell, i) => {
          const disabled = isDayDisabled(cell.day, cell.month, cell.year);
          const selected = isSelected(cell.day, cell.month, cell.year);
          const today = isToday(cell.day, cell.month, cell.year);

          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              onClick={() => handleDayClick(cell)}
              className={[
                "w-8 h-8 rounded-full text-xs font-medium transition-all flex items-center justify-center",
                disabled
                  ? "text-[var(--text-3)] opacity-25 cursor-not-allowed"
                  : "",
                !cell.currentMonth && !disabled
                  ? "text-[var(--text-3)] opacity-40"
                  : "",
                cell.currentMonth && !disabled && !selected
                  ? "text-[var(--text-2)] hover:bg-blue-500/15 hover:text-blue-400"
                  : "",
                selected
                  ? "bg-blue-600 text-white shadow-md shadow-blue-600/25"
                  : "",
                today && !selected
                  ? "ring-1 ring-inset ring-blue-500/50"
                  : "",
              ].join(" ")}
            >
              {cell.day}
            </button>
          );
        })}
      </div>

      {/* ── Time picker ── */}
      <div className="border-t border-[var(--border)] px-4 py-3">
        <div className="flex items-center gap-2">
          <Clock size={14} className="text-[var(--text-3)] flex-shrink-0" />
          <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mr-1">Time</span>

          <select
            value={hour}
            onChange={(e) => setHour(Number(e.target.value))}
            className={selectClass}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>

          <span className="text-sm font-bold text-[var(--text-3)]">:</span>

          <select
            value={minute}
            onChange={(e) => setMinute(Number(e.target.value))}
            className={selectClass}
          >
            {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
              <option key={m} value={m}>{pad2(m)}</option>
            ))}
          </select>

          <select
            value={ampm}
            onChange={(e) => setAmpm(e.target.value as "AM" | "PM")}
            className={selectClass}
          >
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
        </div>
      </div>

      {/* ── Select button ── */}
      <div className="border-t border-[var(--border)] px-4 py-3">
        {isInPast && hasSelection && (
          <p className="text-xs text-amber-400 mb-2">Selected time is in the past — pick a future time.</p>
        )}
        <button
          type="button"
          onClick={handleSelect}
          disabled={!hasSelection || isInPast}
          className="w-full py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-md shadow-blue-600/20"
        >
          Select
        </button>
      </div>
    </div>
  );
}
