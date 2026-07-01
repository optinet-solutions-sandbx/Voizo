"use client";

// Compact per-metric breakdown column (Slice A) — a total + its sub-rows (color dot + label + count +
// pct pill), NO bars (distinct from PerformanceCards' bar'd cards). Used by the Today's-campaigns rows;
// shared so Slice C's Campaign Performance table can adopt it. Display-only UNLESS the caller passes
// onRow/onTotal (Slice E Top Performers drill) — then total + rows render as buttons.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
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
  collapsible = false,
}: {
  metric: PerfMetric;
  label?: string;
  onRow?: (row: PerfRow, parentKey?: string) => void;
  onTotal?: () => void;
  // Opt-in for the Top Performers cards (Slice E), whose 3 columns stack vertically and run tall.
  // Default false → the horizontal camp-row usages (Today's campaigns, Campaign Performance) are unchanged.
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const total = metric.total.toLocaleString();

  // The detailed rows — identical between the non-collapsible path and the expanded-collapsible path.
  const rows = (
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
  );

  // Default (shared) rendering — unchanged for the horizontal camp-row surfaces.
  if (!collapsible) {
    return (
      <div className="min-w-0">
        {label && (
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] mb-1">{label}</div>
        )}
        {onTotal ? (
          <button type="button" onClick={onTotal} className="text-xl font-bold font-mono text-[var(--text-1)] mb-1 hover:text-blue-400 transition-colors cursor-pointer">
            {total}
          </button>
        ) : (
          <div className="text-xl font-bold font-mono text-[var(--text-1)] mb-1">{total}</div>
        )}
        {rows}
      </div>
    );
  }

  // Collapsible (Top Performers). Collapsed: the whole header is one toggle (label + chevron + total +
  // one-line summary), the total does NOT drill. Expanded: the label/chevron collapses, the total drills
  // (onTotal) and rows drill (onRow) exactly as in the default path.
  const labelHead = (
    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{label}</span>
  );

  if (open) {
    return (
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-expanded
          aria-label={label ? `Collapse ${label}` : "Collapse"}
          className="flex items-center justify-between w-full mb-1 group"
        >
          {labelHead}
          <ChevronRight size={12} className="text-[var(--text-3)] rotate-90 transition-transform group-hover:text-[var(--text-2)]" />
        </button>
        {onTotal ? (
          <button type="button" onClick={onTotal} className="text-xl font-bold font-mono text-[var(--text-1)] mb-1 hover:text-blue-400 transition-colors cursor-pointer">
            {total}
          </button>
        ) : (
          <div className="text-xl font-bold font-mono text-[var(--text-1)] mb-1">{total}</div>
        )}
        {rows}
      </div>
    );
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label={label ? `Expand ${label}` : "Expand"}
        className="w-full text-left -mx-1 px-1 py-0.5 rounded-lg hover:bg-[var(--bg-hover)]/40 transition-colors group"
      >
        <div className="flex items-center justify-between mb-1">
          {labelHead}
          <ChevronRight size={12} className="text-[var(--text-3)] transition-transform group-hover:text-[var(--text-2)]" />
        </div>
        <div className="text-xl font-bold font-mono text-[var(--text-1)] mb-1">{total}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-3)]">
          {metric.rows.map((row) => (
            <span key={row.key} className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: ROW_COLOR[row.key] ?? "#8b939c" }} />
              <span className="font-medium font-mono text-[var(--text-2)]">{row.count.toLocaleString()}</span>
              <span>{row.label.toLowerCase()}</span>
            </span>
          ))}
        </div>
      </button>
    </div>
  );
}
