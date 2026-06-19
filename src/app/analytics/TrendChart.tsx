"use client";

// Slice 5a — Trend chart: daily Connect Rate (area, emerald) + Success Rate (line, amber)
// on a dual Y-axis. Driven by the global filters (data comes pre-windowed from the endpoint).
// Recharts (installed). Colors stay consistent with the rest of the dashboard.

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
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

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
      <div className="text-emerald-400">Connect {p.connectRate === null ? "—" : fmtPct(p.connectRate)}</div>
      <div className="text-amber-400">Success {p.successRate === null ? "—" : fmtPct(p.successRate)}</div>
      <div className="text-[var(--text-3)] mt-0.5">{p.calls.toLocaleString()} calls</div>
    </div>
  );
}

export default function TrendChart({ data }: { data: TrendPoint[] }) {
  // Interactive legend: click a series to hide/show its area/line.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <Activity size={15} className="text-[var(--text-3)]" />
        <h3 className="text-[15px] font-semibold">Connect &amp; Success Trend</h3>
      </div>
      <p className="text-[11px] text-[var(--text-3)] mb-3">
        Daily connect rate (area) + success rate (line). Each line has its own scale.
      </p>
      <div className="flex-1 min-h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} stroke="var(--text-3)" fontSize={10} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis yAxisId="left" tickFormatter={fmtPct} stroke="#34d399" fontSize={10} tickLine={false} axisLine={false} width={42} domain={[0, "auto"]} />
          <YAxis yAxisId="right" orientation="right" tickFormatter={fmtPct} stroke="#fbbf24" fontSize={10} tickLine={false} axisLine={false} width={42} domain={[0, "auto"]} />
          <Tooltip content={<TrendTooltip />} />
          {!hidden.has("connectRate") && <Area yAxisId="left" type="monotone" dataKey="connectRate" stroke="#34d399" fill="#34d399" fillOpacity={0.12} strokeWidth={2} connectNulls />}
          {!hidden.has("successRate") && <Line yAxisId="right" type="monotone" dataKey="successRate" stroke="#fbbf24" strokeWidth={2} dot={false} connectNulls />}
        </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex items-center gap-4 mt-2 text-[11px]">
        {([["connectRate", "Connect rate", "bg-emerald-400"], ["successRate", "Success rate", "bg-amber-400"]] as const).map(([key, label, dot]) => {
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
              <span className={`w-2.5 h-2.5 rounded-sm ${dot}`} /> {label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
