"use client";

// Shared presentational 3-card Performance grid (Call attempts / Reached / SMS sent) with breakdown
// rows, bars, pct pills, and OPTIONAL delta chips. Extracted from TodayPerformanceCards (2026-06-30,
// Slice B) so both the always-live Today view (showDeltas=true) and the ranged Global view
// (showDeltas=false — Val's mockup shows no deltas on Global) render identically. Purely
// presentational: the parent supplies the click handlers (→ its own records drawer).

import type { PerfMetric, PerfRow, TodayPerfDay } from "@/lib/dashboardAnalytics";

// Row accent colors — match Val's mockup (vivid bars/dots, distinct from the muted records chips).
const ROW_COLOR: Record<string, string> = {
  reached: "#1baf7a",
  voicemail: "#9085e9",
  unreachable: "#eda100",
  positive: "#1baf7a",
  neutral: "#4a9eed",
  declined: "#e34948",
  early_hangup: "#e06530",
};

const pctText = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const ppText = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`);

function deltaCls(v: number | null): string {
  if (v === null || Math.abs(v) < 0.0005) return "text-[var(--text-3)]";
  return v > 0 ? "text-emerald-400" : "text-red-400";
}

// Two small delta chips (vs yesterday, vs 7-day avg). `fmt` = pctText (totals) or ppText (rows).
function DeltaChips({ a, b, fmt }: { a: number | null; b: number | null; fmt: (v: number | null) => string | null }) {
  const ta = fmt(a);
  const tb = fmt(b);
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium">
      <span className={deltaCls(a)} title="vs yesterday">{ta ?? "—"}</span>
      <span className="text-[var(--border-2)]">·</span>
      <span className={deltaCls(b)} title="vs last 7-day average">{tb ?? "—"}</span>
    </span>
  );
}

function Pill({ pct, color }: { pct: number | null; color: string }) {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: `${color}1f`, color }}>
      {pct === null ? "—" : `${(pct * 100).toFixed(1)}%`}
    </span>
  );
}

function Bar({ pct, color }: { pct: number | null; color: string }) {
  const w = pct === null ? 0 : Math.max(pct * 100, pct > 0 ? 2 : 0);
  return (
    <span className="block h-[3px] rounded-full bg-[var(--bg-elevated)] overflow-hidden">
      <span className="block h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </span>
  );
}

// One breakdown row: label + count + pct pill + (optional) dual pp-deltas, a mini-bar, clickable → drawer.
// `indent` renders the SMS by-response sub-rows under Reached.
function Row({ row, onOpen, showDeltas, indent = false }: { row: PerfRow; onOpen: () => void; showDeltas: boolean; indent?: boolean }) {
  const color = ROW_COLOR[row.key] ?? "#8b939c";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--bg-hover)] transition-colors ${indent ? "pl-4" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-[11px] text-[var(--text-2)] flex items-center gap-1">
          {row.label}
          {row.isEstimated && (
            <span title="Best-effort estimate from call data, not a verified label." className="cursor-help text-[8.5px] uppercase tracking-wider text-[var(--text-3)] border border-[var(--border-2)] rounded px-1">est</span>
          )}
        </span>
        <span className="ml-auto text-[11px] font-medium font-mono text-[var(--text-1)]">{row.count.toLocaleString()}</span>
        <Pill pct={row.pct} color={color} />
        {showDeltas && <DeltaChips a={row.deltaPpVsYesterday} b={row.deltaPpVsSevenDayAvg} fmt={ppText} />}
      </div>
      <div className="mt-1"><Bar pct={row.pct} color={color} /></div>
    </button>
  );
}

function MetricCard({
  label,
  metric,
  isSms,
  inFlight,
  showDeltas,
  onOpenTotal,
  onOpenRow,
}: {
  label: string;
  metric: PerfMetric;
  isSms?: boolean;
  inFlight?: number;
  showDeltas: boolean;
  onOpenTotal: () => void;
  onOpenRow: (row: PerfRow, parentKey?: string) => void;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 flex flex-col gap-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{label}</div>
      <button type="button" onClick={onOpenTotal} className="flex items-baseline gap-2 text-left group w-fit">
        <span className="text-3xl font-bold font-mono text-[var(--text-1)] group-hover:text-blue-400 transition-colors">
          {metric.total.toLocaleString()}
        </span>
        {showDeltas && <DeltaChips a={metric.deltaPctVsYesterday} b={metric.deltaPctVsSevenDayAvg} fmt={pctText} />}
      </button>
      {inFlight !== undefined && inFlight > 0 && (
        <div className="text-[10px] text-[var(--text-3)]">+{inFlight.toLocaleString()} in progress</div>
      )}
      <div className="flex flex-col gap-1.5">
        {metric.rows.map((row) => (
          <div key={row.key} className="flex flex-col gap-1.5">
            <Row row={row} showDeltas={showDeltas} onOpen={() => onOpenRow(row)} />
            {/* SMS "by response" sub-rows live under the Reached row. */}
            {isSms && row.subRows && row.subRows.length > 0 && (
              <div className="flex flex-col gap-1 border-l border-[var(--border)] ml-1.5">
                {row.subRows.map((sub) => (
                  <Row key={sub.key} row={sub} indent showDeltas={showDeltas} onOpen={() => onOpenRow(sub, row.key)} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PerformanceCards({
  perf,
  showDeltas,
  onOpenTotal,
  onOpenRow,
}: {
  perf: TodayPerfDay;
  showDeltas: boolean;
  onOpenTotal: (card: "callAttempts" | "reached" | "sms") => void;
  onOpenRow: (card: "callAttempts" | "reached" | "sms", row: PerfRow, parentKey?: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      <MetricCard
        label="Call attempts"
        metric={perf.callAttempts}
        inFlight={perf.inFlight}
        showDeltas={showDeltas}
        onOpenTotal={() => onOpenTotal("callAttempts")}
        onOpenRow={(row) => onOpenRow("callAttempts", row)}
      />
      <MetricCard
        label="Reached"
        metric={perf.reached}
        showDeltas={showDeltas}
        onOpenTotal={() => onOpenTotal("reached")}
        onOpenRow={(row) => onOpenRow("reached", row)}
      />
      <MetricCard
        label="SMS sent"
        metric={perf.sms}
        isSms
        showDeltas={showDeltas}
        onOpenTotal={() => onOpenTotal("sms")}
        onOpenRow={(row, parentKey) => onOpenRow("sms", row, parentKey)}
      />
    </div>
  );
}
