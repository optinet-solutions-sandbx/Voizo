"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import ChartTooltip from "./ChartTooltip";

interface FunnelWaterfallProps {
  a: CampaignAnalytics;
}

/** Strict nested funnel Targeted ≥ Dialed ≥ Connected ≥ Goal; drops shown as floating steps. */
export default function FunnelWaterfall({ a }: FunnelWaterfallProps) {
  const { targeted, dialedNumbers: dialed, connectedNumbers: connected, goalNumbers: goal } = a;
  const data = [
    { name: "Targeted", base: 0, value: targeted, color: "#6366f1" },
    { name: "Not dialed", base: dialed, value: Math.max(0, targeted - dialed), color: "#f59e0b" },
    { name: "Not reached", base: connected, value: Math.max(0, dialed - connected), color: "#ef4444" },
    { name: "Not converted", base: goal, value: Math.max(0, connected - goal), color: "#fb923c" },
    { name: "Goal", base: 0, value: goal, color: "#22c55e" },
  ];
  const thin = a.confidence === "thin";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">Funnel (numbers)</p>
      <div className={`h-44 w-full ${thin ? "opacity-50" : ""}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 6, right: 6, bottom: 24, left: 0 }}>
            <XAxis dataKey="name" tick={{ fontSize: 9, fill: "var(--text-3)" }} interval={0} angle={-18} textAnchor="end" height={36} />
            <YAxis hide />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={
                <ChartTooltip
                  render={(row) => (
                    <>
                      <p className="font-semibold text-[var(--text-1)]">{String(row.name)}</p>
                      <p className="text-[var(--text-2)]">{String(row.value)}</p>
                    </>
                  )}
                />
              }
            />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="value" stackId="w" isAnimationActive={false} radius={[2, 2, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {thin && <p className="text-[10px] text-[var(--text-3)] mt-1">Thin sample (n&lt;10 connected), directional only.</p>}
    </div>
  );
}
