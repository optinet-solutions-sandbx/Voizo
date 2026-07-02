"use client";

// The metric-card pattern (pattern brief §4 — the core reusable unit): label → hero total
// (tabular mono, CountUp) → ONE delta chip vs a single named baseline (7-day avg) → ONE
// segmented proportion bar (the split shown once) → clean breakdown rows (dot · label ·
// count · % · [Today only] one pp-delta). Shared by the always-live Today view
// (showDeltas=true) and the ranged Global view (showDeltas=false). Purely presentational:
// the parent supplies the click handlers (→ its own records drawer).

import { motion } from "motion/react";
import type { PerfMetric, PerfRow, TodayPerfDay } from "@/lib/dashboardAnalytics";
import Hint from "@/components/Hint";
import CountUp from "@/components/CountUp";

// Semantic palette (pattern brief §2 — desaturated, meaning-only). Exported as the single
// source for every breakdown dot/segment (campaign rows, charts, heatmap accents).
export const ROW_COLOR: Record<string, string> = {
  reached: "#3ec08a",
  voicemail: "#8f86e6",
  unreachable: "#e0a53c",
  positive: "#3ec08a",
  neutral: "#5b9bf0",
  declined: "#e46664",
  early_hangup: "#e0814a",
};

// Delta colors from the same semantic set (green up, red down, neutral flat).
const DELTA_UP = "text-[#3ec08a]";
const DELTA_DOWN = "text-[#e46664]";

/** The "est" honesty badge + its disclosure tooltip — shared by every proxy-outcome row
 *  so wording/styling can't drift. `tone="warn"` = the amber coverage-warning variant. */
export function EstBadge({
  content = "Best-effort estimate from call data, not a verified label.",
  tone = "muted",
}: {
  content?: string;
  tone?: "muted" | "warn";
}) {
  const toneCls =
    tone === "warn" ? "text-amber-400/90 border-amber-400/30" : "text-[var(--text-4)] border-[var(--border-2)]";
  return (
    <Hint content={content}>
      <span className={`cursor-help text-[9px] font-semibold uppercase tracking-[0.06em] border rounded px-1 ${toneCls}`}>est</span>
    </Hint>
  );
}

const pctText = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const ppText = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`);

function deltaCls(v: number | null): string {
  if (v === null || Math.abs(v) < 0.0005) return "text-[var(--text-3)]";
  return v > 0 ? DELTA_UP : DELTA_DOWN;
}
const deltaArrow = (v: number | null) => (v === null || Math.abs(v) < 0.0005 ? "" : v > 0 ? "▲" : "▼");

/** ONE segmented proportion bar — the split shown once, not repeated as N half-empty bars
 *  (pattern brief §4). Segments are flex-weighted by count; zero rows vanish (min-w keeps
 *  slivers visible). Exported for the campaign rows (5px variant). */
export function SegBar({ rows, height = 6 }: { rows: PerfRow[]; height?: number }) {
  const total = rows.reduce((s, r) => s + r.count, 0);
  return (
    <div className="flex gap-[2px] rounded overflow-hidden bg-[#0c0e11]" style={{ height }}>
      {total === 0 ? (
        <div className="flex-1" />
      ) : (
        rows
          .filter((r) => r.count > 0)
          .map((r) => (
            <div
              key={r.key}
              style={{ flex: r.count, background: ROW_COLOR[r.key] ?? "#7d828c", minWidth: 2 }}
            />
          ))
      )}
    </div>
  );
}

// One breakdown row: dot · label · [EST] · count · % · [one pp-delta] — clickable → drawer.
// `indent` renders the SMS by-response sub-rows (smaller dot, no delta column).
function Row({ row, onOpen, showDelta, indent = false }: { row: PerfRow; onOpen: () => void; showDelta: boolean; indent?: boolean }) {
  const color = ROW_COLOR[row.key] ?? "#7d828c";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full flex items-center gap-2 text-left rounded-md px-1.5 py-[5px] -mx-1.5 hover:bg-[var(--bg-hover)] transition-colors ${indent ? "pl-[18px]" : ""}`}
    >
      <span className={`rounded-full shrink-0 ${indent ? "h-[5px] w-[5px] opacity-80" : "h-2 w-2"}`} style={{ background: color }} />
      <span className={`flex items-center gap-1.5 ${indent ? "text-xs text-[var(--text-3)]" : "text-[13px] text-[var(--text-2)]"}`}>
        {row.label}
        {row.isEstimated && <EstBadge />}
      </span>
      <span className="flex-1" />
      <span className={`font-mono ${indent ? "text-xs text-[var(--text-2)]" : "text-[13px] text-[var(--text-1)]"}`}>{row.count.toLocaleString()}</span>
      <span className={`font-mono w-[50px] text-right ${indent ? "text-[11px] text-[var(--text-4)]" : "text-xs text-[var(--text-3)]"}`}>
        {row.pct === null ? "—" : `${(row.pct * 100).toFixed(1)}%`}
      </span>
      {showDelta && !indent && (
        <Hint content="percentage-point change vs the prior 7-day average">
          <span className={`font-mono text-[11px] w-[56px] text-right ${deltaCls(row.deltaPpVsSevenDayAvg)}`}>
            {ppText(row.deltaPpVsSevenDayAvg) ?? "—"}
          </span>
        </Hint>
      )}
      {showDelta && indent && <span className="w-[56px]" />}
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
  const delta = metric.deltaPctVsSevenDayAvg;
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] px-5 py-4 flex flex-col">
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--text-3)] mb-3">{label}</div>
      <div className="flex items-baseline gap-2.5">
        <button type="button" onClick={onOpenTotal} className="group text-left">
          <CountUp
            value={metric.total}
            className="text-[34px] leading-none font-semibold font-mono tracking-[-0.025em] text-[var(--text-1)] group-hover:text-primary transition-colors"
          />
        </button>
        {showDeltas && (
          <span className={`inline-flex items-center gap-0.5 font-mono text-[12.5px] font-medium ${deltaCls(delta)}`}>
            {deltaArrow(delta)}
            {pctText(delta) ?? "—"}
          </span>
        )}
        {showDeltas && <span className="ml-auto text-[11px] text-[var(--text-4)]">vs 7-day avg</span>}
      </div>
      {inFlight !== undefined && inFlight > 0 && (
        <div className="text-[10px] text-[var(--text-3)] mt-1.5">+{inFlight.toLocaleString()} in progress</div>
      )}
      <div className="my-4">
        <SegBar rows={metric.rows} />
      </div>
      <div className="flex flex-col">
        {metric.rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <Row row={row} showDelta={showDeltas} onOpen={() => onOpenRow(row)} />
            {/* SMS "by response" sub-rows live under the Reached row. */}
            {isSms &&
              row.subRows?.map((sub) => (
                <Row key={sub.key} row={sub} indent showDelta={showDeltas} onOpen={() => onOpenRow(sub, row.key)} />
              ))}
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
  // "In progress" (inFlight) is a LIVE concept — only meaningful on the always-live Today view.
  const callInFlight = showDeltas ? perf.inFlight : undefined;
  // Staggered entrance (0 / 70 / 140ms) — the cards "arrive" left-to-right on first paint.
  const entrance = (i: number) => ({
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.35, delay: i * 0.07, ease: "easeOut" as const },
  });
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
      <motion.div {...entrance(0)}>
        <MetricCard
          label="Call attempts"
          metric={perf.callAttempts}
          inFlight={callInFlight}
          showDeltas={showDeltas}
          onOpenTotal={() => onOpenTotal("callAttempts")}
          onOpenRow={(row) => onOpenRow("callAttempts", row)}
        />
      </motion.div>
      <motion.div {...entrance(1)}>
        <MetricCard
          label="Reached"
          metric={perf.reached}
          showDeltas={showDeltas}
          onOpenTotal={() => onOpenTotal("reached")}
          onOpenRow={(row) => onOpenRow("reached", row)}
        />
      </motion.div>
      <motion.div {...entrance(2)}>
        <MetricCard
          label="SMS sent"
          metric={perf.sms}
          isSms
          showDeltas={showDeltas}
          onOpenTotal={() => onOpenTotal("sms")}
          onOpenRow={(row, parentKey) => onOpenRow("sms", row, parentKey)}
        />
      </motion.div>
    </div>
  );
}
