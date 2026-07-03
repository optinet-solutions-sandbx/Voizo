"use client";

// Shared expandable campaign row (Slice C) — the mockup's camp-row, used by BOTH Today's-campaigns and
// Campaign Performance. Chips (country/players/date) + a status pill + a time label + three compact
// BreakdownColumns. Straight-to-records (Val's mockup, 2026-07-02): chevron/name → records unfiltered;
// clicking a breakdown total/row (when the parent passes onMetricPick) → records pre-filtered to that
// slice. `trailing` slots extra row UI (e.g. CampaignTable's "Open in campaign" link).

import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, Flag, Users, Calendar, Repeat } from "lucide-react";
import type { PerfMetric, PerfRow, DisplayStatus } from "@/lib/dashboardAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { useBaseAgentNames } from "./useBaseAgentNames";
import { SegBar, MetricRow } from "./PerformanceCards";
import CampaignExpand from "@/components/analytics/CampaignExpand";
import { metricPickSlice, type RecordSlice } from "./recordsDisplay";
import Hint from "@/components/Hint";
import PromptHoverCard from "./PromptHoverCard";

// Derived display status — single source of truth is deriveDisplayStatus in dashboardAnalytics;
// re-exported here so CampaignTable keeps importing it from the row component. 4 states after the
// 2026-07-03 vocab trim (Completed + Ended folded into "Finished").
export type { DisplayStatus };
export const STATUS_META: Record<DisplayStatus, { label: string; cls: string; pulse?: boolean }> = {
  running: { label: "Running", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", pulse: true },
  paused: { label: "Paused", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  finished: { label: "Finished", cls: "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]" },
  inactive: { label: "Inactive", cls: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]" },
};
export function StatusPill({ s }: { s: DisplayStatus }) {
  const m = STATUS_META[s];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border w-fit ${m.cls}`}>
      {m.pulse && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {m.label}
    </span>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export interface CampaignRowData {
  id: string;
  name: string;
  country: string;
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  scheduleType?: "fixed" | "recurring"; // "recurring" renders a marker on the agent line
  status: DisplayStatus;
  timeLabel: string; // runtime ("3h 12m") for running, or run-window ("27 Jun → ongoing") for the table
  players: number;
  startAt: string | null;
  perf: { callAttempts: PerfMetric; reached: PerfMetric; sms: PerfMetric };
}

// Shared grid template — header row + every campaign row align to it.
export const CAMPAIGN_ROW_GRID = "grid grid-cols-[minmax(220px,1.6fr)_minmax(110px,auto)_repeat(3,minmax(150px,1fr))] gap-4";

type MetricKey = "callAttempts" | "reached" | "sms";
const METRIC_TITLE: Record<MetricKey, string> = { callAttempts: "Call attempts", reached: "Reached", sms: "SMS sent" };

// Collapsed metric cell (scan mode, pattern brief §7): 21px tabular total + 5px proportion
// bar — the split shown once. Clickable when the parent wires slices (drill pre-filtered).
function MetricCell({ metric, onClick }: { metric: PerfMetric; onClick?: () => void }) {
  const inner = (
    <>
      <div className="text-[21px] leading-none font-semibold font-mono tracking-[-0.02em] text-[var(--text-1)] group-hover:text-primary transition-colors">
        {metric.total.toLocaleString()}
      </div>
      <div className="mt-2">
        <SegBar rows={metric.rows} height={5} />
      </div>
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="min-w-0 text-left group">
      {inner}
    </button>
  ) : (
    <div className="min-w-0">{inner}</div>
  );
}

export default function CampaignRow({
  c,
  expanded,
  onToggle,
  onViewPrompt,
  trailing,
  slice,
  sliceLabel,
  onMetricPick,
  onClearSlice,
}: {
  c: CampaignRowData;
  expanded: boolean;
  onToggle: () => void;
  onViewPrompt: () => void;
  trailing?: ReactNode;
  slice?: RecordSlice; // active records slice for THIS row's expand (parent-owned)
  sliceLabel?: string;
  onMetricPick?: (slice: RecordSlice, label: string) => void; // breakdown total/row click → expand pre-filtered
  onClearSlice?: () => void; // slice badge × — clear filter, keep records open
}) {
  const baseAgentName = useBaseAgentNames();
  const fmt = formatCampaign(c.name);
  // Breakdown click → slice handlers (only when the parent opted in). Rows also cover the
  // SMS "By response" sub-rows — same callback, same slice machinery.
  const pickTotal = (metric: MetricKey) =>
    onMetricPick
      ? () => {
          const p = metricPickSlice(metric);
          onMetricPick(p.slice, p.label);
        }
      : undefined;
  const pickRow = (metric: MetricKey) =>
    onMetricPick
      ? (row: PerfRow) => {
          const p = metricPickSlice(metric, row.key, row.label);
          onMetricPick(p.slice, p.label);
        }
      : undefined;
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <div className={`${CAMPAIGN_ROW_GRID} px-3.5 py-2.5 items-start hover:bg-[var(--bg-hover)]/40 transition-colors`}>
        {/* Campaign */}
        <div className="min-w-0">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1.5 text-left min-w-0 group"
            aria-label={expanded ? "Collapse call records" : "Expand call records"}
          >
            <ChevronRight size={14} className={`text-[var(--text-3)] shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            <span className="text-sm font-semibold text-[var(--text-1)] truncate group-hover:text-primary transition-colors" title={c.name}>
              {fmt.offer || fmt.display}
            </span>
          </button>
          <div className="text-[11px] text-[var(--text-3)] mt-1 flex items-center gap-1.5 flex-wrap">
            <span>{baseAgentName(c.baseAssistantId) ?? voiceName(c.voiceId, { short: true }) ?? "—"}</span>
            {c.scheduleType === "recurring" && (
              <>
                <span className="text-[var(--border-2)]">·</span>
                <Hint content="Recurring campaign — spawns a fresh run on its cadence.">
                  <span className="inline-flex items-center gap-1 text-[var(--text-2)]">
                    <Repeat size={10} /> recurring
                  </span>
                </Hint>
              </>
            )}
            <span className="text-[var(--border-2)]">·</span>
            <PromptHoverCard campaignId={c.id}>
              <button type="button" onClick={onViewPrompt} className="text-primary hover:text-primary/80 transition-colors">
                view prompt
              </button>
            </PromptHoverCard>
            {trailing}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[10px] text-[var(--text-3)]">
            {c.country !== "UNKNOWN" && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">
                <Flag size={10} /> {c.country}
              </span>
            )}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
              <Users size={10} /> {c.players.toLocaleString()} players
            </span>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
              <Calendar size={10} /> {fmtDay(c.startAt)}
            </span>
          </div>
        </div>

        {/* Status + time */}
        <div className="flex flex-col gap-1">
          <StatusPill s={c.status} />
          {c.timeLabel && <span className="text-[10px] font-mono text-[var(--text-3)]">{c.timeLabel}</span>}
        </div>

        {/* Scan mode (§7): totals + proportion bars only — the full breakdown lives in the expand. */}
        <MetricCell metric={c.perf.callAttempts} onClick={pickTotal("callAttempts")} />
        <MetricCell metric={c.perf.reached} onClick={pickTotal("reached")} />
        <MetricCell metric={c.perf.sms} onClick={pickTotal("sms")} />
      </div>

      {/* Height-animated expand (the mockup's 0.3s rp transition). initial={false} so rows
          already expanded on mount don't replay the animation. */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="expand"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="overflow-hidden bg-[var(--bg-app)]"
          >
            {/* Drill mode (§7): the full per-metric breakdown; rows re-slice the records below. */}
            <div className="border-t border-[var(--border)] bg-[var(--bg-panel)] px-4 py-4 grid gap-x-7 gap-y-4 md:grid-cols-3">
              {(["callAttempts", "reached", "sms"] as const).map((mk) => {
                const metric = c.perf[mk];
                const onRow = pickRow(mk);
                return (
                  <div key={mk} className="min-w-0">
                    <div className="text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--text-4)] mb-1.5">
                      {METRIC_TITLE[mk]} · <span className="font-mono">{metric.total.toLocaleString()}</span>
                    </div>
                    {metric.rows.map((row) => (
                      <div key={row.key}>
                        <MetricRow row={row} showDelta={false} onOpen={() => onRow?.(row)} />
                        {mk === "sms" &&
                          row.subRows?.map((sub) => (
                            <MetricRow key={sub.key} row={sub} indent showDelta={false} onOpen={() => onRow?.(sub)} />
                          ))}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <CampaignExpand
              campaignId={c.id}
              name={c.name}
              slice={slice}
              sliceLabel={sliceLabel}
              onClearSlice={onClearSlice}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
