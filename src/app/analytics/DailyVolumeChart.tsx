"use client";

// Slice 5b — Daily call volume: stacked bar, calls per day broken down by campaign
// (top-10 + "Other"), campaign-colored. Driven by the global filters. Recharts.

import { useState } from "react";
import { BarChart3 } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { toggleKey } from "@/lib/toggleSet";
import type { VolumeResult, VolumeSeries } from "@/lib/dashboardAnalytics";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : (iso ?? "");
}

// Color per COUNTRY, keyed by the country itself (NOT by volume rank) so a filter that changes the
// set never repaints the survivors. Australia/Canada keep the blue/green they've always shown; other
// known countries get fixed hues; anything else gets a deterministic (name-hashed) fallback; the
// unparseable "other" bucket is the dimmest neutral.
const COUNTRY_COLORS: Record<string, string> = {
  Australia: "#4d90f0",
  Canada: "#3ec08a",
  "United Kingdom": "#8f86e6",
  "United States": "#e0a53c",
  Philippines: "#e46664",
};
const COUNTRY_FALLBACK = ["#5b9bf0", "#c98a4a", "#e0814a", "#3a6fd0", "#9b7fe0"];
function countryColor(name: string): string {
  if (name === "other") return "#565b64";
  if (COUNTRY_COLORS[name]) return COUNTRY_COLORS[name];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COUNTRY_FALLBACK[h % COUNTRY_FALLBACK.length];
}
function buildColors(series: VolumeSeries[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of series) out[s.key] = countryColor(s.key);
  return out;
}
const seriesLabel = (s: VolumeSeries) => s.name;
const seriesFull = (s: VolumeSeries) => s.name;

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
      <p className="text-[12.5px] text-[var(--text-3)] mb-3">Calls per day, stacked by country.</p>
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
                  title={`${seriesFull(s)}. Click to ${off ? "show" : "hide"}`}
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
