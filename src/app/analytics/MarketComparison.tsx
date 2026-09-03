"use client";

// Market Comparison (dashboard mockup, ported 2026-09-03): where the volume goes versus which
// market connects, per market, same window. Two bars a row: share of calls, and connect rate
// (connected / completed, prod's definition). Colour keys by the country itself, the same
// function Daily Call Volume uses, so a filter that changes the set never repaints the survivors.
import { Globe2 } from "lucide-react";
import type { MarketRow } from "@/lib/dashboardAnalytics";
import WidgetCard from "./WidgetCard";
import { countryColor } from "./DailyVolumeChart";
import { ROW_COLOR } from "./PerformanceCards";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function MarketComparison({ markets }: { markets: MarketRow[] }) {
  const total = markets.reduce((s, m) => s + m.calls, 0);
  return (
    <WidgetCard
      title="Market Comparison"
      icon={<Globe2 size={14} className="text-[var(--text-3)]" />}
      context="volume share vs connect rate, per market, same window"
    >
      {markets.length === 0 ? (
        <p className="text-xs text-[var(--text-3)] py-8 text-center">No calls in this window. An empty result is an answer.</p>
      ) : (
        <div className="grid gap-2">
          <div className="grid grid-cols-[110px_1fr_52px_1fr_52px] gap-2 text-[10px] uppercase tracking-wider text-[var(--text-4)]">
            <span /><span>volume share</span><span /><span>connect rate</span><span />
          </div>
          {markets.map((m) => {
            const share = total ? (m.calls / total) * 100 : 0;
            const rate = m.terminal ? (m.connected / m.terminal) * 100 : 0;
            const name = m.country === "other" ? "Other" : m.country;
            return (
              <div key={m.country} className="grid grid-cols-[110px_1fr_52px_1fr_52px] items-center gap-2 text-[12px]" title={`${name}: ${fmt(m.calls)} calls · ${fmt(m.connected)} connected of ${fmt(m.terminal)} completed`}>
                <span className="text-[var(--text-2)] truncate">{name}</span>
                <div className="h-[7px] rounded bg-[var(--bg-elevated)] overflow-hidden"><span className="block h-full rounded" style={{ width: `${share.toFixed(1)}%`, background: countryColor(m.country) }} /></div>
                <span className="font-mono text-[var(--text-1)] text-right tabular-nums">{share.toFixed(1)}%</span>
                <div className="h-[7px] rounded bg-[var(--bg-elevated)] overflow-hidden"><span className="block h-full rounded" style={{ width: `${rate.toFixed(1)}%`, background: ROW_COLOR.reached }} /></div>
                <span className="font-mono text-[var(--text-1)] text-right tabular-nums">{m.terminal ? `${rate.toFixed(1)}%` : "—"}</span>
              </div>
            );
          })}
          {markets.length === 1 && (
            <p className="text-[11px] text-[var(--text-3)] mt-1">One market in scope. A comparison needs a second market; this is an answer, not a failure.</p>
          )}
        </div>
      )}
    </WidgetCard>
  );
}
