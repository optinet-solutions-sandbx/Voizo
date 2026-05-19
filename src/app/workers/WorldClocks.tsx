// src/app/workers/WorldClocks.tsx
//
// World-clocks panel: pick a UTC offset (defaults to viewer's local
// machine timezone) and see all cities in that offset with their current
// local time. Single dropdown — never floods the card with 30 rows.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

// ── Anchor cities for the panel — same set used by the globe pins. ──────
// If you'd rather pull this from the campaigns/v2 timezone column directly,
// import { TIMEZONE_COORDS } from "./timezone-coords" and derive { city, tz }
// from it. This panel uses a slightly broader set so we surface time zones
// that have no active campaign yet.

const CLOCK_CITIES: { city: string; tz: string }[] = [
  { city: "Vancouver",   tz: "America/Vancouver" },
  { city: "Los Angeles", tz: "America/Los_Angeles" },
  { city: "Denver",      tz: "America/Denver" },
  { city: "Chicago",     tz: "America/Chicago" },
  { city: "Toronto",     tz: "America/Toronto" },
  { city: "New York",    tz: "America/New_York" },
  { city: "Mexico City", tz: "America/Mexico_City" },
  { city: "São Paulo",   tz: "America/Sao_Paulo" },
  { city: "Buenos Aires",tz: "America/Argentina/Buenos_Aires" },
  { city: "London",      tz: "Europe/London" },
  { city: "Paris",       tz: "Europe/Paris" },
  { city: "Berlin",      tz: "Europe/Berlin" },
  { city: "Madrid",      tz: "Europe/Madrid" },
  { city: "Rome",        tz: "Europe/Rome" },
  { city: "Amsterdam",   tz: "Europe/Amsterdam" },
  { city: "Stockholm",   tz: "Europe/Stockholm" },
  { city: "Athens",      tz: "Europe/Athens" },
  { city: "Istanbul",    tz: "Europe/Istanbul" },
  { city: "Moscow",      tz: "Europe/Moscow" },
  { city: "Dubai",       tz: "Asia/Dubai" },
  { city: "Mumbai",      tz: "Asia/Kolkata" },
  { city: "Bangkok",     tz: "Asia/Bangkok" },
  { city: "Singapore",   tz: "Asia/Singapore" },
  { city: "Hong Kong",   tz: "Asia/Hong_Kong" },
  { city: "Shanghai",    tz: "Asia/Shanghai" },
  { city: "Manila",      tz: "Asia/Manila" },
  { city: "Tokyo",       tz: "Asia/Tokyo" },
  { city: "Seoul",       tz: "Asia/Seoul" },
  { city: "Sydney",      tz: "Australia/Sydney" },
  { city: "Auckland",    tz: "Pacific/Auckland" },
];

// ─────────────────────────────────────────────────────────────────────────

function getOffsetLabel(now: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now);
    const off = parts.find(p => p.type === "timeZoneName")?.value ?? "";
    return off.replace("GMT", "UTC") || "UTC";
  } catch { return "UTC"; }
}

function parseOffsetMinutes(label: string): number {
  if (label === "UTC" || label === "UTC+0" || label === "UTC-0") return 0;
  const m = /UTC([+-])(\d+)(?::(\d+))?/.exec(label);
  if (!m) return 0;
  const sign = m[1] === "+" ? 1 : -1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
}

function formatTime(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
    }).format(now);
  } catch { return "--:--"; }
}

// ─────────────────────────────────────────────────────────────────────────

export default function WorldClocks({ now }: { now: Date }) {
  const userTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { return "UTC"; }
  }, []);
  const userOffsetLabel = useMemo(() => getOffsetLabel(now, userTz), [userTz, now]);

  // Group cities by their CURRENT UTC offset (DST-aware).
  const groups = useMemo(() => {
    const m = new Map<string, typeof CLOCK_CITIES>();
    for (const c of CLOCK_CITIES) {
      const off = getOffsetLabel(now, c.tz);
      if (!m.has(off)) m.set(off, []);
      m.get(off)!.push(c);
    }
    return Array.from(m.entries()).sort((a, b) => parseOffsetMinutes(a[0]) - parseOffsetMinutes(b[0]));
  }, [now]);

  const [selected, setSelected] = useState<string>(() => userOffsetLabel);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // If selection drifts out of the available offsets, snap to first.
  const selectedGroup = groups.find(([k]) => k === selected) ?? groups[0];
  const selectedKey = selectedGroup?.[0] ?? selected;
  const selectedCities = selectedGroup?.[1] ?? [];

  // Outside-click closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden max-h-full">
      <div className="px-4 pt-4 pb-3 border-b border-[var(--border)]">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-base font-semibold text-[var(--text-1)]">World Clocks</h2>
          <span className="text-[11px] text-[var(--text-3)] font-mono">
            {selectedCities.length} {selectedCities.length === 1 ? "city" : "cities"}
          </span>
        </div>

        <div ref={wrapperRef} className="relative">
          <button
            onClick={() => setOpen(o => !o)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg text-[var(--text-1)] hover:border-[var(--border-2)] transition">
            <span className="font-mono text-sm font-medium flex-1 text-left">{selectedKey}</span>
            {selectedKey === userOffsetLabel && (
              <span className="text-[10px] uppercase tracking-widest text-emerald-400 font-mono">local</span>
            )}
            <ChevronDown size={12} className={`text-[var(--text-3)] transition-transform ${open ? "rotate-180" : ""}`} />
          </button>

          {open && (
            <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-[var(--bg-card)] border border-[var(--border-2)] rounded-lg shadow-2xl overflow-hidden max-h-64 overflow-y-auto p-1 backdrop-blur-xl">
              {groups.map(([offset, cities]) => (
                <button
                  key={offset}
                  onClick={() => { setSelected(offset); setOpen(false); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md font-mono text-[11px] text-left transition ${
                    offset === selectedKey ? "bg-[var(--bg-elevated)] text-[var(--text-1)]" : "hover:bg-[var(--bg-hover)] text-[var(--text-1)]"
                  }`}>
                  <span className="flex-1">{offset}</span>
                  {offset === userOffsetLabel && (
                    <span className="text-[9px] uppercase tracking-widest text-emerald-400">local</span>
                  )}
                  <span className="text-[10px] text-[var(--text-3)]">{cities.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {selectedCities.length === 0 ? (
          <p className="px-2 py-3 text-[11px] italic text-[var(--text-3)]">No cities in this offset.</p>
        ) : (
          <div className="flex flex-col">
            {selectedCities.map(c => (
              <div key={c.city}
                   className="flex items-baseline justify-between px-2 py-2 border-b border-[var(--border)] last:border-b-0">
                <span className="text-[12px] text-[var(--text-1)]">{c.city}</span>
                <span className="font-mono text-[11px] text-[var(--text-2)] tabular-nums">{formatTime(now, c.tz)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
