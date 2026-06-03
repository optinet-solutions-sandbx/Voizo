"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import ChartTooltip from "./ChartTooltip";

interface FailureMixBarProps {
  a: CampaignAnalytics;
}

export default function FailureMixBar({ a }: FailureMixBarProps) {
  const m = a.failureMix;
  const data = [
    { name: "no_answer", count: m.no_answer, color: "#8b5cf6" },
    { name: "busy", count: m.busy, color: "#6366f1" },
    { name: "failed", count: m.failed, color: "#ef4444" },
    { name: "canceled", count: m.canceled, color: "#7b828c" },
  ];
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">Non-connect failure mix</p>
      <div className="h-44 w-full">
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
                      <p className="text-[var(--text-2)]">{String(row.count)} calls</p>
                    </>
                  )}
                />
              }
            />
            <Bar dataKey="count" radius={[2, 2, 0, 0]} isAnimationActive={false}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-[var(--text-3)] mt-1">{a.nonConnectTotal} non-connect calls · a failed spike = carrier/cost canary.</p>
    </div>
  );
}
