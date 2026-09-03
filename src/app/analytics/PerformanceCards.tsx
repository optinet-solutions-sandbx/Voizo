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
  agent_timeout: "#c264d6", // matches ATTEMPT_TAG_COLOR (VOZ-330)
  silent_pickup: "#a8814f", // matches ATTEMPT_TAG_COLOR (2026-08-13)
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
// Exported for the campaign-row expand panels (drill mode, pattern brief §7).
// `indent` renders the SMS by-response sub-rows (smaller dot, no delta column).
export function MetricRow({ row, onOpen, showDelta, indent = false, noDrillHint }: { row: PerfRow; onOpen: () => void; showDelta: boolean; indent?: boolean; noDrillHint?: string }) {
  const color = ROW_COLOR[row.key] ?? "#7d828c";
  // `noDrillHint` = this row has a real count but the drawer behind it CANNOT
  // reproduce it, so drilling would open an empty list under a non-zero number
  // (Val 2026-08-07: card said Reached 12, sub-rows summed to 2). Render the
  // count, drop the click, and say why on hover — never a dead button.
  const inner = (
    <>
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
    </>
  );
  const cls = `w-full flex items-center gap-2 text-left rounded-md px-1.5 py-[5px] -mx-1.5 ${indent ? "pl-[18px]" : ""}`;
  if (noDrillHint) {
    return (
      <Hint content={noDrillHint}>
        <div className={`${cls} cursor-help opacity-70`}>{inner}</div>
      </Hint>
    );
  }
  return (
    <button type="button" onClick={onOpen} className={`${cls} hover:bg-[var(--bg-hover)] transition-colors`}>
      {inner}
    </button>
  );
}

function MetricCard({
  label,
  metric,
  isSms,
  inFlight,
  showDeltas,
  compact,
  zeroWord = "this window",
  onOpenTotal,
  onOpenRow,
  noDrillHintFor,
}: {
  label: string;
  metric: PerfMetric;
  isSms?: boolean;
  inFlight?: number;
  showDeltas: boolean;
  compact?: boolean;
  zeroWord?: string;
  onOpenTotal: () => void;
  onOpenRow: (row: PerfRow, parentKey?: string) => void;
  noDrillHintFor?: (row: PerfRow) => string | undefined;
}) {
  const delta = metric.deltaPctVsSevenDayAvg;
  // Compact (mockup, Jasiel 2026-09-03 "less is more"): a row with nothing in it is not a row,
  // it is a word in one muted line, so the card holds only the buckets that happened. Sub-rows
  // fold the same way. Off on Today, where the zero rows carry deltas.
  const zeroLabels: string[] = [];
  const rows = compact
    ? metric.rows.filter((row) => {
        if (row.count > 0) return true;
        zeroLabels.push(row.label);
        return false;
      })
    : metric.rows;
  const subRowsOf = (row: PerfRow): PerfRow[] | undefined => {
    if (!compact) return row.subRows;
    return row.subRows?.filter((sub) => {
      if (sub.count > 0) return true;
      zeroLabels.push(sub.label);
      return false;
    });
  };
  return (
    <div className="h-full bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] px-5 py-[18px] flex flex-col">
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--text-3)] mb-3">{label}</div>
      <div className="flex items-baseline gap-2.5">
        <button type="button" onClick={onOpenTotal} className="group text-left">
          <CountUp
            value={metric.total}
            className="text-[38px] leading-none font-semibold font-mono tracking-[-0.025em] text-[var(--text-1)] group-hover:text-primary transition-colors"
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
      <div className="flex flex-col flex-1">
        {rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <MetricRow row={row} showDelta={showDeltas} onOpen={() => onOpenRow(row)} noDrillHint={noDrillHintFor?.(row)} />
            {/* SMS "by response" sub-rows live under the Reached row. */}
            {isSms &&
              subRowsOf(row)?.map((sub) => (
                <MetricRow key={sub.key} row={sub} indent showDelta={showDeltas} onOpen={() => onOpenRow(sub, row.key)} noDrillHint={noDrillHintFor?.(sub)} />
              ))}
          </div>
        ))}
        {compact && zeroLabels.length > 0 && (
          // Pinned to the card's foot so three cards of different row counts still align.
          <div className="mt-auto pt-3 text-[11px] leading-relaxed text-[var(--text-3)]">
            {rows.length === 0 ? `Nothing ${zeroWord}: ` : `Zero ${zeroWord}: `}
            {zeroLabels.join(" · ")}
          </div>
        )}
      </div>
    </div>
  );
}

export default function PerformanceCards({
  perf,
  showDeltas,
  onOpenTotal,
  onOpenRow,
  noDrillHintFor,
  compact = false,
  zeroWord = "this window",
}: {
  perf: TodayPerfDay;
  showDeltas: boolean;
  onOpenTotal: (card: "callAttempts" | "reached" | "sms") => void;
  onOpenRow: (card: "callAttempts" | "reached" | "sms", row: PerfRow, parentKey?: string) => void;
  /** Per-row opt-OUT of drilling: return a reason and the row renders as a
   *  non-interactive count with that reason on hover. For surfaces whose drawer
   *  cannot reproduce a row (the Campaign Performance summary block, whose
   *  ranged drawer is transcript-less and so can never list silent pickups).
   *  Omitted everywhere else, so /today and the ranged cards are unchanged. */
  noDrillHintFor?: (row: PerfRow) => string | undefined;
  /** Fold zero rows into one muted line at the card's foot. */
  compact?: boolean;
  /** The period named in that line: "Zero this window" (default), "Zero today", "Zero yesterday". */
  zeroWord?: string;
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
    <div className="flex flex-wrap gap-4 items-stretch">
      <motion.div {...entrance(0)} className="flex-1 min-w-[260px]">
        <MetricCard
          label="Call attempts"
          metric={perf.callAttempts}
          inFlight={callInFlight}
          showDeltas={showDeltas}
          compact={compact}
          zeroWord={zeroWord}
          onOpenTotal={() => onOpenTotal("callAttempts")}
          onOpenRow={(row) => onOpenRow("callAttempts", row)}
          noDrillHintFor={noDrillHintFor}
        />
      </motion.div>
      <motion.div {...entrance(1)} className="flex-1 min-w-[260px]">
        <MetricCard
          label="Conversations Established"
          metric={perf.reached}
          showDeltas={showDeltas}
          compact={compact}
          zeroWord={zeroWord}
          onOpenTotal={() => onOpenTotal("reached")}
          onOpenRow={(row) => onOpenRow("reached", row)}
          noDrillHintFor={noDrillHintFor}
        />
      </motion.div>
      <motion.div {...entrance(2)} className="flex-1 min-w-[260px]">
        <MetricCard
          label="SMS sent"
          metric={perf.sms}
          isSms
          showDeltas={showDeltas}
          compact={compact}
          zeroWord={zeroWord}
          onOpenTotal={() => onOpenTotal("sms")}
          onOpenRow={(row, parentKey) => onOpenRow("sms", row, parentKey)}
          noDrillHintFor={noDrillHintFor}
        />
      </motion.div>
    </div>
  );
}
