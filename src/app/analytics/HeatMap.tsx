"use client";

// Slice 5c — Daily × Hourly heatmap. Rows = dates, cols = hours 00–23 in each campaign's LOCAL
// time (calls from campaigns with no/invalid timezone fall back to UTC — disclosed in the caption).
// Cell color intensity ∝ call volume. Hover a cell for the full per-campaign breakdown (attempts /
// reached / voicemail / positive for that slot — post-06-26 vocab). CSS grid (no chart lib).
// Driven by the global filters.

import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { campaignShortLabel } from "@/lib/campaignDisplay";
import type { HeatCell } from "@/lib/dashboardAnalytics";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (h: number) => String(h).padStart(2, "0");
const pctOf = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");
// Reached (human-only) = connected − voicemail. Works for both HeatCell and HeatBreakdown.
const reachedOf = (x: { connected: number; voicemailConnected: number }) => x.connected - x.voicemailConnected;

function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} · ${WD[d.getUTCDay()]}`;
}

export default function HeatMap({ cells, utcFallbackCalls }: { cells: HeatCell[]; utcFallbackCalls: number }) {
  const [hover, setHover] = useState<{ cell: HeatCell; x: number; y: number } | null>(null);
  const byKey = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c]));
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const maxCalls = cells.reduce((m, c) => Math.max(m, c.calls), 0) || 1;
  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <div className="flex items-center gap-2">
          <LayoutGrid size={15} className="text-[var(--text-3)]" />
          <h3 className="text-[15px] font-semibold">Daily &amp; Hourly Heat Map</h3>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-[var(--text-3)]">
          Fewer
          <span className="flex gap-0.5">
            {[0.15, 0.35, 0.55, 0.75, 0.95].map((a) => (
              <span key={a} className="w-3 h-3 rounded-sm" style={{ background: `rgba(52,211,153,${a})` }} />
            ))}
          </span>
          More
        </div>
      </div>
      <p className="text-[11px] text-[var(--text-3)] mb-3">
        Call attempts by hour in each campaign&apos;s local time · hover any cell for the full breakdown.
        {utcFallbackCalls > 0 && (
          <span className="text-amber-400/80">
            {" "}· {utcFallbackCalls.toLocaleString()} call{utcFallbackCalls === 1 ? "" : "s"} from campaigns without a set timezone shown in UTC.
          </span>
        )}
      </p>

      {days.length === 0 ? (
        <p className="text-xs text-[var(--text-3)] py-8 text-center">No calls in this window.</p>
      ) : (
        <div className="overflow-auto max-h-[640px]">
          <table className="border-separate w-full min-w-[780px] table-fixed" style={{ borderSpacing: 2 }}>
            <thead>
              <tr>
                <th className="text-left text-[9px] uppercase tracking-wider text-[var(--text-3)] font-medium pr-2 w-28 sticky left-0 top-0 z-20 bg-[var(--bg-card)]">Date</th>
                {hours.map((h) => (
                  <th key={h} className="text-[9px] text-[var(--text-3)] font-mono font-normal sticky top-0 z-10 bg-[var(--bg-card)]">{pad(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day}>
                  <td className="text-[10px] font-mono text-[var(--text-2)] whitespace-nowrap pr-2 sticky left-0 z-10 bg-[var(--bg-card)]">{dayLabel(day)}</td>
                  {hours.map((h) => {
                    const cell = byKey.get(`${day}|${h}`);
                    const alpha = cell ? 0.12 + 0.8 * (cell.calls / maxCalls) : 0;
                    return (
                      <td
                        key={h}
                        onMouseEnter={(e) => cell && setHover({ cell, x: e.clientX, y: e.clientY })}
                        onMouseMove={(e) => cell && setHover({ cell, x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHover(null)}
                        className="h-8 text-center align-middle text-[10px] font-mono rounded-sm"
                        style={{
                          background: cell ? `rgba(52,211,153,${alpha})` : "var(--bg-elevated)",
                          color: cell && alpha > 0.55 ? "#06281c" : "var(--text-3)",
                        }}
                      >
                        {cell ? cell.calls : ""}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hover && (
        <div
          style={{ position: "fixed", left: hover.x + 14, top: hover.y + 14, zIndex: 60 }}
          className="pointer-events-none bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs shadow-2xl max-w-[300px]"
        >
          <div className="text-[var(--text-2)] font-medium">
            {dayLabel(hover.cell.day)} · {pad(hover.cell.hour)}:00
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 mb-1.5 text-[11px]">
            <span className="text-[var(--text-3)]">Attempts <span className="text-[var(--text-1)] font-mono">{hover.cell.calls}</span></span>
            <span className="text-[var(--text-3)]">Reached <span className="text-emerald-400 font-mono">{reachedOf(hover.cell)} · {pctOf(reachedOf(hover.cell), hover.cell.calls)}</span></span>
            <span className="text-[var(--text-3)]">Voicemail <span className="font-mono" style={{ color: "#9085e9" }}>{hover.cell.voicemailConnected}</span></span>
            <span className="text-[var(--text-3)]">Positive <span className="text-amber-400 font-mono">{hover.cell.successful} · {pctOf(hover.cell.successful, reachedOf(hover.cell))}</span></span>
          </div>
          <div className="grid gap-0.5 border-t border-[var(--border)] pt-1.5">
            {hover.cell.breakdown.map((b, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="truncate text-[var(--text-2)] flex-1">{campaignShortLabel(b.name)}</span>
                <span className="font-mono text-[var(--text-3)] shrink-0">{b.calls}c · {reachedOf(b)}r · {b.voicemailConnected}vm · {b.successful}✓</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
