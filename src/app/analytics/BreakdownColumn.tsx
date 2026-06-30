"use client";

// Compact per-metric breakdown column (Slice A) — a total + its sub-rows (color dot + label + count +
// pct pill), NO bars (distinct from PerformanceCards' bar'd cards). Used by the Today's-campaigns rows;
// shared so Slice C's Campaign Performance table can adopt it. Display-only UNLESS the caller passes
// onRow/onTotal (Slice E Top Performers drill) — then total + rows render as buttons.

import type { PerfMetric, PerfRow } from "@/lib/dashboardAnalytics";
import { ROW_COLOR } from "./PerformanceCards";

function SubRow({ row, indent = false, onClick }: { row: PerfRow; indent?: boolean; onClick?: () => void }) {
  const color = ROW_COLOR[row.key] ?? "#8b939c";
  const inner = (
    <>
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
    </>
  );
  const base = `flex items-center gap-2 py-0.5 ${indent ? "pl-3.5" : ""}`;
  return onClick ? (
    <button type="button" onClick={onClick} className={`${base} w-full text-left -mx-1 px-1 rounded hover:bg-[var(--bg-hover)] transition-colors cursor-pointer`}>
      {inner}
    </button>
  ) : (
    <div className={base}>{inner}</div>
  );
}

export default function BreakdownColumn({
  metric,
  label,
  onRow,
  onTotal,
}: {
  metric: PerfMetric;
  label?: string;
  onRow?: (row: PerfRow, parentKey?: string) => void;
  onTotal?: () => void;
}) {
  return (
    <div className="min-w-0">
      {label && (
        <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] mb-1">{label}</div>
      )}
      {onTotal ? (
        <button type="button" onClick={onTotal} className="text-xl font-bold font-mono text-[var(--text-1)] mb-1 hover:text-blue-400 transition-colors cursor-pointer">
          {metric.total.toLocaleString()}
        </button>
      ) : (
        <div className="text-xl font-bold font-mono text-[var(--text-1)] mb-1">{metric.total.toLocaleString()}</div>
      )}
      <div className="flex flex-col">
        {metric.rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <SubRow row={row} onClick={onRow ? () => onRow(row) : undefined} />
            {row.subRows?.map((sub) => (
              <SubRow key={sub.key} row={sub} indent onClick={onRow ? () => onRow(sub, row.key) : undefined} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
