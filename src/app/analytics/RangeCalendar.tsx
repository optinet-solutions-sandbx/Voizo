"use client";

// The window picker (dashboard mockup, ported 2026-09-03). ONE calendar vocabulary across the
// dashboard: Campaign Performance's own range and Global Performance's Custom range open the
// same popover. Day, Week, Month, Year or Range, each compiling to one from→to pair through
// lib/rangeCalendar (unit-tested); this file only draws and handles clicks.
//
// Run counts ride every cell (mockup): a day, week, month or year says how many runs it holds,
// so the operator picks a window that has something in it. A week with no runs is disabled;
// days stay clickable inside Day and Range because a range needs arbitrary endpoints.

import { useEffect, useRef, useState } from "react";
import { Calendar } from "lucide-react";
import {
  GRANULARITIES, MONTHS_SHORT, type Granularity,
  addDays, weekStart, granularityWindow, daysOfMonth, weeksOfMonth, countRuns, shiftMonth,
  windowCaption, shortDay, isIsoDay,
} from "@/lib/rangeCalendar";

export default function RangeCalendar({
  from,
  to,
  runDates,
  onApply,
  ariaLabel = "Pick a window",
  todayIso = new Date().toISOString().slice(0, 10),
}: {
  /** Current window, "YYYY-MM-DD" or "" for an open end. */
  from: string;
  to: string;
  /** Run dates in scope (everything except the window), for the counts on the cells. */
  runDates: string[];
  /** Fires with the compiled window on Select. ("", "") clears to all time. */
  onApply: (from: string, to: string) => void;
  ariaLabel?: string;
  todayIso?: string;
}) {
  const [open, setOpen] = useState(false);
  const [gran, setGran] = useState<Granularity>("week");
  const [view, setView] = useState<string>((isIsoDay(from) ? from : todayIso).slice(0, 7)); // "YYYY-MM"
  const [jump, setJump] = useState(false); // the month/year jump picker
  const [a, setA] = useState<string | null>(null); // the picked anchor
  const [b, setB] = useState<string | null>(null); // the range's second endpoint
  const wrap = useRef<HTMLDivElement>(null);

  // Opening seeds the pick from the current window, the way the mockup does.
  const openIt = () => {
    const seed = isIsoDay(from) ? from : todayIso;
    setView(seed.slice(0, 7));
    setJump(false);
    setA(gran === "week" ? weekStart(seed) : seed);
    setB(gran === "range" && isIsoDay(to) ? to : null);
    setOpen(true);
  };
  const close = () => { setOpen(false); setJump(false); setA(null); setB(null); };
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) close(); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const [vy, vm] = view.split("-").map(Number);
  const perDay = countRuns(runDates, "day");
  const perWeek = countRuns(runDates, "week");
  const perMonth = countRuns(runDates, "month");
  const perYear = countRuns(runDates, "year");
  const pending: [string, string] | null = a ? granularityWindow(gran, a, b) : null;
  const runsIn = pending ? runDates.filter((d) => d >= pending[0] && d <= pending[1]).length : 0;
  const n = (v: number | undefined) => (v ? `${v} run${v === 1 ? "" : "s"}` : "no runs");

  const pick = (g: Granularity) => { setGran(g); setA(null); setB(null); setJump(false); };
  const pickDay = (d: string) => {
    if (gran === "range" && a && !b) setB(d);
    else { setA(d); setB(null); }
    setView(d.slice(0, 7));
  };
  const apply = () => {
    if (pending) onApply(pending[0], pending[1]);
    close();
  };

  const cell = "relative rounded-[7px] font-mono text-[11px] border border-transparent transition-colors";
  const idle = "text-[var(--text-2)] hover:border-[var(--border-2)]";
  const sel = "bg-primary text-white font-semibold";
  const count = (v: number | undefined) => v ? <i className="absolute top-0.5 right-1 not-italic text-[8px] opacity-80">{v}</i> : null;

  let body: React.ReactNode;
  if (jump) {
    body = (
      <>
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-3)] mt-2 mb-1">Year</div>
        <div className="grid grid-cols-4 gap-[3px]">
          {[vy - 2, vy - 1, vy, vy + 1].map((y) => (
            <button key={y} type="button" onClick={() => setView(`${y}-${String(vm).padStart(2, "0")}`)} className={`${cell} py-1.5 ${y === vy ? "border-primary text-[var(--text-1)]" : idle}`}>{y}{count(perYear.get(String(y)))}</button>
          ))}
        </div>
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-3)] mt-2 mb-1">Month</div>
        <div className="grid grid-cols-4 gap-[3px]">
          {MONTHS_SHORT.map((mo, i) => {
            const key = `${vy}-${String(i + 1).padStart(2, "0")}`;
            return <button key={key} type="button" onClick={() => { setView(key); setJump(false); }} className={`${cell} py-1.5 ${i + 1 === vm ? sel : idle}`} title={`${n(perMonth.get(key))} in ${mo} ${vy}`}>{mo}{count(perMonth.get(key))}</button>;
          })}
        </div>
      </>
    );
  } else if (gran === "week") {
    body = (
      <>
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-3)] mt-2 mb-1">Week</div>
        <div className="flex flex-col gap-[3px]">
          {weeksOfMonth(`${view}-01`).map((ws) => {
            const c = perWeek.get(ws);
            const on = a && weekStart(a) === ws;
            return (
              <button key={ws} type="button" disabled={!c} onClick={() => { setA(ws); setB(null); }} title={`${n(c)} this week`}
                className={`${cell} flex items-center gap-2 px-2.5 py-1.5 text-left disabled:opacity-40 disabled:cursor-not-allowed ${on ? "border-primary text-[var(--text-1)]" : idle}`}>
                {shortDay(ws)} – {shortDay(addDays(ws, 6))}<span className="ml-auto text-[var(--text-3)]">{c ? `${c} run${c === 1 ? "" : "s"}` : "—"}</span>
              </button>
            );
          })}
        </div>
      </>
    );
  } else if (gran === "day" || gran === "range") {
    const lo = b && a && b < a ? b : a, hi = b && a && b > a ? b : a;
    const days = daysOfMonth(`${view}-01`);
    const lead = new Date(`${days[0]}T00:00:00Z`).getUTCDay();
    body = (
      <>
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-3)] mt-2 mb-1">{gran === "range" ? "Range — pick a start, then an end" : "Day"}</div>
        <div className="grid grid-cols-7 gap-[3px] text-center">
          {["S", "M", "T", "W", "T", "F", "S"].map((w, i) => <span key={i} className="text-[9px] text-[var(--text-4)]">{w}</span>)}
          {Array.from({ length: lead }, (_, i) => <span key={`lead-${i}`} />)}
          {days.map((d) => {
            const c = perDay.get(d);
            const on = !!(a && lo && hi && d >= lo && d <= hi);
            return <button key={d} type="button" onClick={() => pickDay(d)} title={`${n(c)} on ${shortDay(d)}`} className={`${cell} py-1.5 ${on ? sel : idle} ${d === todayIso ? "underline" : ""}`}>{Number(d.slice(8))}{count(c)}</button>;
          })}
        </div>
      </>
    );
  } else if (gran === "month") {
    body = (
      <>
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-3)] mt-2 mb-1">Month</div>
        <div className="grid grid-cols-4 gap-[3px]">
          {MONTHS_SHORT.map((mo, i) => {
            const key = `${vy}-${String(i + 1).padStart(2, "0")}`;
            return <button key={key} type="button" onClick={() => { setA(`${key}-01`); setB(null); }} title={`${n(perMonth.get(key))} in ${mo} ${vy}`} className={`${cell} py-1.5 ${a && a.slice(0, 7) === key ? sel : idle}`}>{mo}{count(perMonth.get(key))}</button>;
          })}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--text-3)] mt-2 mb-1">Year</div>
        <div className="grid grid-cols-4 gap-[3px]">
          {[vy - 2, vy - 1, vy, vy + 1].map((y) => (
            <button key={y} type="button" onClick={() => { setA(`${y}-01-01`); setB(null); }} title={`${n(perYear.get(String(y)))} in ${y}`} className={`${cell} py-1.5 ${a && a.slice(0, 4) === String(y) ? sel : idle}`}>{y}{count(perYear.get(String(y)))}</button>
          ))}
        </div>
      </>
    );
  }

  return (
    <div ref={wrap} className="relative inline-block">
      <button
        type="button"
        onClick={() => (open ? close() : openIt())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-xs font-mono text-[var(--text-2)] hover:text-[var(--text-1)] hover:border-[var(--border-2)] transition"
      >
        <Calendar size={12} className="text-[var(--text-3)]" />
        {windowCaption(from, to)}
      </button>
      {open && (
        <div role="dialog" aria-label={ariaLabel} className="absolute right-0 top-[calc(100%+5px)] z-40 w-[250px] p-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30">
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex gap-px">
              <button type="button" onClick={() => setView(shiftMonth(view, -12))} title="Previous year" className="w-[22px] h-[22px] rounded-md text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]">«</button>
              <button type="button" onClick={() => setView(shiftMonth(view, -1))} title="Previous month" className="w-[22px] h-[22px] rounded-md text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]">‹</button>
            </div>
            <button type="button" onClick={() => setJump((j) => !j)} aria-expanded={jump} title="Jump to a month or year" className="px-2 py-0.5 rounded-md text-[12.5px] font-mono font-medium text-[var(--text-1)] hover:bg-[var(--bg-hover)]">
              {MONTHS_SHORT[vm - 1]} {vy} <span className="text-[var(--text-3)]">▾</span>
            </button>
            <div className="flex gap-px">
              <button type="button" onClick={() => setView(shiftMonth(view, 1))} title="Next month" className="w-[22px] h-[22px] rounded-md text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]">›</button>
              <button type="button" onClick={() => setView(shiftMonth(view, 12))} title="Next year" className="w-[22px] h-[22px] rounded-md text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]">»</button>
            </div>
          </div>
          <div className="grid grid-cols-5 gap-[3px]">
            {GRANULARITIES.map((g) => (
              <button key={g.key} type="button" onClick={() => pick(g.key)} aria-pressed={gran === g.key}
                className={`py-1 rounded-[7px] text-[11px] transition-colors ${gran === g.key ? "bg-[var(--bg-elevated)] text-[var(--text-1)] border border-[var(--border-2)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}>
                {g.label}
              </button>
            ))}
          </div>
          {body}
          <div className="text-center font-mono text-[11px] text-[var(--text-3)] mt-2">
            {pending ? `${runsIn} run${runsIn === 1 ? "" : "s"} in ${pending[0] === pending[1] ? shortDay(pending[0]) : `${shortDay(pending[0])} – ${shortDay(pending[1])}`}` : "pick a window"}
          </div>
          <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-[var(--border)] text-[11px]">
            <div className="flex gap-3">
              <button type="button" onClick={() => { onApply("", ""); close(); }} className="text-[var(--text-3)] hover:text-[var(--text-1)]" title="All time">Clear</button>
              <button type="button" onClick={() => { setView(todayIso.slice(0, 7)); setA(gran === "week" ? weekStart(todayIso) : todayIso); setB(null); }} className="text-[var(--text-3)] hover:text-[var(--text-1)]">Today</button>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={close} className="text-[var(--text-3)] hover:text-[var(--text-1)]">Cancel</button>
              <button type="button" onClick={apply} disabled={!pending} className="px-2.5 py-1 rounded-md bg-primary text-white font-medium disabled:opacity-40">Select</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
