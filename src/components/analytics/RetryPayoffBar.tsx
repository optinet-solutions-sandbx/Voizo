"use client";

import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { ANALYTICS_CONFIG } from "@/lib/analyticsConfig";
import ChartTooltip from "./ChartTooltip";

interface RetryPayoffBarProps {
  a: CampaignAnalytics;
}

export default function RetryPayoffBar({ a }: RetryPayoffBarProps) {
  const data = a.retryPayoff
    .filter((p) => p.connectRate !== null)
    .map((p) => ({
      name: `#${p.attempt}`,
      pct: Math.round((p.connectRate as number) * 1000) / 10,
      dialed: p.dialed,
      connected: p.connected,
      // Per-bar small-sample weighting: a later attempt dialed to only a handful of numbers gives
      // a noisy connect-rate that shouldn't read as authoritatively as a high-volume early attempt.
      // Fade bars below SAMPLE_FLOOR_THIN (the same n=10 floor that marks a campaign "thin").
      low: p.dialed < ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN,
    }));
  const thin = a.confidence === "thin";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">Retry payoff (connect rate by attempt)</p>
      <div className={`h-44 w-full ${thin ? "opacity-50" : ""}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 6, bottom: 24, left: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 10, fill: "var(--text-3)" }} interval={0} height={20} />
            <YAxis hide domain={[0, 100]} />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={
                <ChartTooltip
                  render={(row) => (
                    <>
                      <p className="font-semibold text-[var(--text-1)]">Attempt {String(row.name)}</p>
                      <p className="text-[var(--text-2)]">
                        {String(row.pct)}% connect ({String(row.connected)}/{String(row.dialed)})
                      </p>
                      {Number(row.dialed) < ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN && (
                        <p className="text-amber-400/80">{`Low sample (n<${ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN}), interpret with caution`}</p>
                      )}
                    </>
                  )}
                />
              }
            />
            <Bar dataKey="pct" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill="#22c55e" fillOpacity={d.low ? 0.3 : 1} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-[var(--text-3)] mt-1">
        {data.length === 0
          ? "No retry data."
          : `Faded bars are low-sample (n<${ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN}); later attempts are survivorship-biased, so read N≥3 as conditional.`}
      </p>
    </div>
  );
}
