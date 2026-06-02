"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import ChartTooltip from "./ChartTooltip";

interface DurationHistogramProps {
  a: CampaignAnalytics;
}

function bucketLabel(lowerSec: number, upperSec: number | null): string {
  return upperSec === null ? `${lowerSec}s+` : `${lowerSec}-${upperSec}s`;
}

export default function DurationHistogram({ a }: DurationHistogramProps) {
  const data = a.durationHistogram.map((b) => ({ label: bucketLabel(b.lowerSec, b.upperSec), count: b.count }));
  const total = a.durationHistogram.reduce((s, b) => s + b.count, 0);
  const thin = a.confidence === "thin";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">Connected-call duration</p>
      <div className={`h-44 w-full ${thin ? "opacity-50" : ""}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 6, bottom: 24, left: 0 }}>
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: "var(--text-3)" }} interval={0} angle={-18} textAnchor="end" height={36} />
            <YAxis hide />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={
                <ChartTooltip
                  render={(row) => (
                    <>
                      <p className="font-semibold text-[var(--text-1)]">{String(row.label)}</p>
                      <p className="text-[var(--text-2)]">{String(row.count)} calls</p>
                    </>
                  )}
                />
              }
            />
            <Bar dataKey="count" fill="#8b5cf6" radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-[var(--text-3)] mt-1">
        {total === 0 ? (
          "No connected-call durations yet."
        ) : (
          <>
            median {a.durationMedian ?? "—"}s · p95 {a.durationP95 ?? "—"}s{thin ? " · thin, directional only" : ""}
          </>
        )}
      </p>
    </div>
  );
}
