"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
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
                    </>
                  )}
                />
              }
            />
            <Bar dataKey="pct" fill="#22c55e" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-[var(--text-3)] mt-1">
        {data.length === 0 ? "No retry data." : "Later attempts are survivorship-biased — read N≥3 as conditional."}
      </p>
    </div>
  );
}
