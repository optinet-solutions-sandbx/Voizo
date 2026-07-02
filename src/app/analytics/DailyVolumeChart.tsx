"use client";

// Slice 5b — Daily call volume: stacked bar, calls per day broken down by campaign
// (top-10 + "Other"), campaign-colored. Driven by the global filters. Recharts.

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { formatCampaign, campaignShortLabel } from "@/lib/campaignDisplay";
import { toggleKey } from "@/lib/toggleSet";
import type { VolumeResult, VolumeSeries } from "@/lib/dashboardAnalytics";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : (iso ?? "");
}

// Deterministic per-campaign color (matches CampaignTable). "other" is neutral gray.
function campaignColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 68% 55%)`;
}
const seriesColor = (key: string) => (key === "other" ? "#6b7280" : campaignColor(key));
const seriesLabel = (s: VolumeSeries) => (s.key === "other" ? s.name : campaignShortLabel(s.name));
const seriesFull = (s: VolumeSeries) => (s.key === "other" ? s.name : formatCampaign(s.name).display);

function VolumeTooltip({
  active,
  payload,
  label,
  series,
  colors,
}: {
  active?: boolean;
  payload?: { dataKey: string; value: number }[];
  label?: string;
  series: VolumeSeries[];
  colors: Record<string, string>;
}) {
  if (!active || !payload?.length) return null;
  const labelFor = (key: string) => {
    const s = series.find((x) => x.key === key);
    return s ? seriesLabel(s) : key;
  };
  const rows = payload.filter((p) => p.value > 0);
  const total = rows.reduce((a, p) => a + p.value, 0);
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs shadow-xl max-w-[280px]">
      <div className="text-[var(--text-2)] font-medium mb-1.5">
        {shortDay(label ?? "")} · {total.toLocaleString()} calls
      </div>
      <div className="grid gap-0.5">
        {rows.map((p) => (
          <div key={p.dataKey} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: colors[p.dataKey] ?? "#565b64" }} />
            <span className="truncate text-[var(--text-2)]">{labelFor(p.dataKey)}</span>
            <span className="ml-auto font-mono text-[var(--text-1)]">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DailyVolumeChart({ data }: { data: VolumeResult }) {
  const { days, series } = data;
  // Interactive legend: clicking a campaign hides/shows its bars (stack re-totals accordingly).
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const visible = series.filter((s) => !hidden.has(s.key));
  const colors = buildColors(series);
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] p-5">
      <div className="flex items-center gap-2 mb-1">
        <BarChart3 size={16} style={{ color: "#3ec08a" }} />
        <h3 className="text-[15px] font-semibold">Daily Call Volume</h3>
      </div>
      <p className="text-[12.5px] text-[var(--text-3)] mb-3">Calls per day, stacked by campaign (top 10 + other).</p>
      {series.length === 0 ? (
        <p className="text-xs text-[var(--text-3)] py-8 text-center">No call volume in this window.</p>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={days} margin={{ top: 5, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="day" tickFormatter={shortDay} stroke="var(--text-3)" fontSize={10} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis stroke="var(--text-3)" fontSize={10} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
              <Tooltip content={<VolumeTooltip series={series} colors={colors} />} cursor={{ fill: "var(--bg-hover)", opacity: 0.4 }} />
              {visible.map((s) => (
                <Bar key={s.key} dataKey={s.key} stackId="v" fill={colors[s.key]} maxBarSize={48} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-3.5 pt-3 border-t border-[var(--border)]">
            {series.map((s) => {
              const off = hidden.has(s.key);
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setHidden((h) => toggleKey(h, s.key))}
                  title={`${seriesFull(s)} — click to ${off ? "show" : "hide"}`}
                  aria-pressed={!off}
                  className={`inline-flex items-center gap-1.5 text-[11px] transition ${off ? "text-[var(--text-3)] opacity-40 line-through" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
                >
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: colors[s.key] }} />
                  <span className="truncate max-w-[200px]">{seriesLabel(s)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
