"use client";

// Activity Trend (Val 2026-06-26): daily Call Attempts (area) + Reached (line) + SMS Sent (line)
// as COUNTS on a single axis — replaces the old Connect/Success rate dual-axis chart. Driven by
// the global filters (data comes pre-windowed from the endpoint). Recharts (installed).

import { useState } from "react";
import { Activity } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { toggleKey } from "@/lib/toggleSet";
import type { TrendPoint } from "@/lib/dashboardAnalytics";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso;
}
const fmtCount = (v: number) => v.toLocaleString();

// dataKey → [label, hex] — the brief's restrained semantic set. Order = legend + tooltip order.
const SERIES = [
  ["calls", "Call attempts", "#5b9bf0"],
  ["reached", "Reached", "#3ec08a"],
  ["smsSent", "SMS sent", "#8f86e6"],
] as const;

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { payload: TrendPoint }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs shadow-xl">
      <div className="text-[var(--text-2)] font-medium mb-1">{shortDay(label ?? p.day)}</div>
      <div style={{ color: "#5b9bf0" }}>{p.calls.toLocaleString()} attempts</div>
      <div style={{ color: "#3ec08a" }}>{p.reached.toLocaleString()} reached</div>
      <div style={{ color: "#8f86e6" }}>{p.smsSent.toLocaleString()} SMS sent</div>
    </div>
  );
}

export default function TrendChart({ data }: { data: TrendPoint[] }) {
  // Interactive legend: click a series to hide/show its area/line.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] p-5 flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <Activity size={16} style={{ color: "#5b9bf0" }} />
        <h3 className="text-[15px] font-semibold">Activity Trend</h3>
      </div>
      <p className="text-[12.5px] text-[var(--text-3)] mb-3">
        Daily call attempts, players reached, and offer texts sent.
      </p>
      <div className="flex-1 min-h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} stroke="var(--text-3)" fontSize={10} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis tickFormatter={fmtCount} stroke="var(--text-3)" fontSize={10} tickLine={false} axisLine={false} width={42} domain={[0, "auto"]} allowDecimals={false} />
          <Tooltip content={<TrendTooltip />} />
          {!hidden.has("calls") && <Area type="monotone" dataKey="calls" stroke="#5b9bf0" fill="#5b9bf0" fillOpacity={0.1} strokeWidth={2} connectNulls />}
          {!hidden.has("reached") && <Line type="monotone" dataKey="reached" stroke="#3ec08a" strokeWidth={2} dot={false} connectNulls />}
          {!hidden.has("smsSent") && <Line type="monotone" dataKey="smsSent" stroke="#8f86e6" strokeWidth={2} dot={false} connectNulls />}
        </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-4 flex-wrap mt-3.5 pt-3 border-t border-[var(--border)] text-xs">
        {SERIES.map(([key, label, hex]) => {
          const off = hidden.has(key);
          return (
            <button
              key={key}
              type="button"
              onClick={() => setHidden((h) => toggleKey(h, key))}
              title={`Click to ${off ? "show" : "hide"} ${label.toLowerCase()}`}
              aria-pressed={!off}
              className={`inline-flex items-center gap-1.5 transition ${off ? "text-[var(--text-3)] opacity-40 line-through" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
            >
              <span className="w-[11px] h-[3px] rounded-sm" style={{ background: hex }} /> {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
