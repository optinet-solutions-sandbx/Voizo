"use client";

// Compact per-metric breakdown column (Slice A) — a total + its sub-rows (color dot + label + count +
// pct pill), NO bars (distinct from PerformanceCards' bar'd cards). Used by the Today's-campaigns rows;
// shared so Slice C's Campaign Performance table can adopt it. Display-only (no click handlers).

import type { PerfMetric, PerfRow } from "@/lib/dashboardAnalytics";
import { ROW_COLOR } from "./PerformanceCards";

function SubRow({ row, indent = false }: { row: PerfRow; indent?: boolean }) {
  const color = ROW_COLOR[row.key] ?? "#8b939c";
  return (
    <div className={`flex items-center gap-2 py-0.5 ${indent ? "pl-3.5" : ""}`}>
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: color }} />
      <span className="text-[11px] text-[var(--text-2)] flex items-center gap-1">
        {row.label}
        {row.isEstimated && (
          <span title="Best-effort estimate from call data, not a verified label." className="cursor-help text-[8.5px] uppercase tracking-wider text-[var(--text-3)] border border-[var(--border-2)] rounded px-1">est</span>
        )}
      </span>
      <span className="ml-auto text-[11px] font-medium font-mono text-[var(--text-1)]">{row.count.toLocaleString()}</span>
      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: `${color}1f`, color }}>
        {row.pct === null ? "—" : `${(row.pct * 100).toFixed(1)}%`}
      </span>
    </div>
  );
}

export default function BreakdownColumn({ metric, label }: { metric: PerfMetric; label?: string }) {
  return (
    <div className="min-w-0">
      {label && (
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] mb-1">{label}</div>
      )}
      <div className="text-xl font-bold font-mono text-[var(--text-1)] mb-1">{metric.total.toLocaleString()}</div>
      <div className="flex flex-col">
        {metric.rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <SubRow row={row} />
            {row.subRows?.map((sub) => (
              <SubRow key={sub.key} row={sub} indent />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
