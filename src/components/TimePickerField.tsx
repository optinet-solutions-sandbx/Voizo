// src/app/campaigns/v2/new/components/TimePickerField.tsx
//
// Time picker styled after the handoff prototype's TimePicker
// (voizo-handoff/src/app/campaigns/v2/new/TimePicker.tsx) but with a 12h↔24h
// adapter at the boundary so the wizard's ScheduleRow data model stays
// in "HH:MM" 24-hour form (matching CallWindow contract).
//
// Operators interact with 12-hour time + AM/PM; the form / callWindows
// / Supabase round-trip stays 24-hour.

"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Clock } from "lucide-react";

interface Props {
  /** "HH:MM" 24-hour, e.g. "09:00" or "21:30". */
  value: string;
  /** Fires with "HH:MM" 24-hour when the operator clicks Confirm. */
  onChange: (value: string) => void;
}

interface PickerState {
  hour: number;        // 1-12 (12-hour display)
  min: number;         // 0-59 (5-minute grid; minor outside 15-min marks)
  ampm: "AM" | "PM";
  focus: "hour" | "min";
}

/** Parse "HH:MM" 24-hour → 12-hour picker state. */
function parse24(v: string): PickerState {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return { hour: 9, min: 0, ampm: "AM", focus: "hour" };
  const h24 = Math.min(23, Math.max(0, +m[1]));
  const min = Math.min(59, Math.max(0, +m[2]));
  const ampm: "AM" | "PM" = h24 >= 12 ? "PM" : "AM";
  let hour = h24 % 12;
  if (hour === 0) hour = 12;
  return { hour, min, ampm, focus: "hour" };
}

/** 12-hour picker state → "HH:MM" 24-hour. */
function fmt24(s: Pick<PickerState, "hour" | "min" | "ampm">): string {
  let h24 = s.hour % 12;
  if (s.ampm === "PM") h24 += 12;
  return `${String(h24).padStart(2, "0")}:${String(s.min).padStart(2, "0")}`;
}

/** "HH:MM" 24-hour → "9:00 AM" display string for the trigger button. */
function fmtDisplay(v24: string): string {
  const { hour, min, ampm } = parse24(v24);
  return `${hour}:${String(min).padStart(2, "0")} ${ampm}`;
}

export default function TimePickerField({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<PickerState>(() => parse24(value));
  const wrap = useRef<HTMLDivElement>(null);

  // Re-sync internal state when the prop changes from outside (e.g. timezone
  // cascade resets all rows to the new region's hours). Only re-parse while
  // closed to avoid clobbering an in-flight pick.
  //
  // Legitimate "sync internal state to an external prop" case. The
  // React-19 lint rule `react-hooks/set-state-in-effect` is over-eager here
  // — there's no way to derive `s` directly from `value` while preserving
  // mid-edit state on the popover.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!open) setS(parse24(value));
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
    onChange(fmt24(s));
    setOpen(false);
  }

  function setNow() {
    const d = new Date();
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm: "AM" | "PM" = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    setS({ ...s, hour: h, min: m - (m % 5), ampm });
  }

  const cells =
    s.focus === "hour"
      ? Array.from({ length: 12 }, (_, i) => i + 1)
      : [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  return (
    <div ref={wrap} className="relative flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border-[1.5px] text-[var(--text-1)] text-sm font-mono font-medium transition ${
          open
            ? "border-blue-500 ring-[3px] ring-blue-500/20"
            : "border-[var(--border)] hover:border-[var(--border-2)]"
        }`}
      >
        <Clock size={14} className="text-[var(--text-3)]" />
        <span className="flex-1 text-left">{fmtDisplay(value)}</span>
        <ChevronDown
          size={13}
          className={`text-[var(--text-3)] transition ${open ? "rotate-180 text-blue-400" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute top-full mt-1.5 left-0 z-50 min-w-[280px] bg-[var(--bg-card)] border border-[var(--border-2)] rounded-2xl shadow-2xl p-3.5">
          {/* Header */}
          <div className="flex items-baseline justify-between px-0.5 mb-2.5">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-3)]">
              Choose a time
            </span>
            <button
              type="button"
              onClick={setNow}
              className="text-[11px] text-blue-400 px-2 py-1 rounded font-medium hover:bg-blue-500/[0.12]"
            >
              Now
            </button>
          </div>

          {/* Large display HH : MM AM/PM */}
          <div className="flex items-baseline justify-center gap-1 py-2 pb-3.5 font-mono text-4xl font-bold tracking-tight">
            <button
              type="button"
              onClick={() => setS({ ...s, focus: "hour" })}
              className={`px-1.5 rounded-lg cursor-pointer transition ${
                s.focus === "hour" ? "bg-blue-500/20 text-blue-400" : "hover:bg-[var(--bg-elevated)]"
              }`}
            >
              {String(s.hour).padStart(2, "0")}
            </button>
            <span className="text-[var(--text-3)] font-normal">:</span>
            <button
              type="button"
              onClick={() => setS({ ...s, focus: "min" })}
              className={`px-1.5 rounded-lg cursor-pointer transition ${
                s.focus === "min" ? "bg-blue-500/20 text-blue-400" : "hover:bg-[var(--bg-elevated)]"
              }`}
            >
              {String(s.min).padStart(2, "0")}
            </button>
            <span className="text-[18px] font-sans font-semibold text-[var(--text-1)] ml-2 self-center pb-1">
              {s.ampm}
            </span>
          </div>

          {/* Hour/Minute focus toggle */}
          <div className="flex gap-1 mb-2.5 p-0.5 bg-[var(--bg-app)] rounded-lg">
            {(["hour", "min"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setS({ ...s, focus: k })}
                className={`flex-1 py-1.5 rounded-md text-[11px] font-semibold uppercase tracking-wide transition ${
                  s.focus === k
                    ? "bg-[var(--bg-card)] text-[var(--text-1)] shadow-sm"
                    : "text-[var(--text-3)] hover:text-[var(--text-1)]"
                }`}
              >
                {k === "hour" ? "Hour" : "Minute"}
              </button>
            ))}
          </div>

          {/* Cell grid (4-col layout matches reference design) */}
          <div className="grid grid-cols-4 gap-1.5">
            {cells.map((c) => {
              const active = s.focus === "hour" ? c === s.hour : c === s.min;
              const minor = s.focus === "min" && c % 15 !== 0;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setS(s.focus === "hour" ? { ...s, hour: c, focus: "min" } : { ...s, min: c })
                  }
                  className={`py-2.5 rounded-lg font-mono text-[13px] font-medium transition ${
                    active
                      ? "bg-blue-500 text-white"
                      : `bg-[var(--bg-app)] text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] ${minor ? "opacity-55" : ""}`
                  }`}
                >
                  {s.focus === "hour" ? c : String(c).padStart(2, "0")}
                </button>
              );
            })}
          </div>

          {/* AM/PM toggle */}
          <div className="flex gap-1.5 mt-3 p-0.5 bg-[var(--bg-app)] rounded-lg">
            {(["AM", "PM"] as const).map((ap) => (
              <button
                key={ap}
                type="button"
                onClick={() => setS({ ...s, ampm: ap })}
                className={`flex-1 py-2 rounded-md text-xs font-semibold transition ${
                  s.ampm === ap
                    ? "bg-[var(--bg-card)] text-[var(--text-1)] shadow-sm"
                    : "text-[var(--text-3)] hover:text-[var(--text-1)]"
                }`}
              >
                {ap}
              </button>
            ))}
          </div>

          {/* Quick presets */}
          <div className="flex gap-1.5 flex-wrap mt-3 pt-3 border-t border-[var(--border)]">
            {[
              { h: 9, m: 0, ap: "AM" as const, label: "9:00 AM" },
              { h: 12, m: 0, ap: "PM" as const, label: "12:00 PM" },
              { h: 5, m: 0, ap: "PM" as const, label: "5:00 PM" },
              { h: 9, m: 0, ap: "PM" as const, label: "9:00 PM" },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setS({ ...s, hour: p.h, min: p.m, ampm: p.ap })}
                className="px-2.5 py-1.5 rounded-md bg-[var(--bg-app)] border border-[var(--border)] text-[11px] text-[var(--text-2)] hover:border-blue-500 hover:text-blue-400 transition"
              >
                <span className="font-mono">{p.label}</span>
              </button>
            ))}
          </div>

          {/* Footer */}
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
              className="px-4 py-1.5 rounded-lg bg-blue-500 text-white text-xs font-semibold hover:bg-blue-400 transition shadow-md shadow-blue-500/20"
            >
              Confirm
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
