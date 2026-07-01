"use client";

// Shared expandable campaign row (Slice C) — the mockup's camp-row, used by BOTH Today's-campaigns and
// Campaign Performance. Chips (country/players/date) + a status pill + a time label + three compact
// BreakdownColumns; chevron/row click → the reused CampaignExpand (lazy per-campaign analytics, owned by
// the parent). `trailing` slots extra row UI (e.g. CampaignTable's "Open in campaign" link).

import type { ReactNode } from "react";
import { ChevronRight, Flag, Users, Calendar, Repeat } from "lucide-react";
import type { PerfMetric } from "@/lib/dashboardAnalytics";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { useBaseAgentNames } from "./useBaseAgentNames";
import BreakdownColumn from "./BreakdownColumn";
import CampaignExpand from "@/components/analytics/CampaignExpand";

// Derived display status (shared with CampaignTable's status filter).
export type DisplayStatus = "running" | "completed" | "ended" | "paused" | "inactive";
export const STATUS_META: Record<DisplayStatus, { label: string; cls: string; pulse?: boolean }> = {
  running: { label: "Running", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", pulse: true },
  completed: { label: "Completed", cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  ended: { label: "Ended", cls: "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]" },
  paused: { label: "Paused", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
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

export default function CampaignRow({
  c,
  expanded,
  onToggle,
  analytics,
  onViewPrompt,
  trailing,
}: {
  c: CampaignRowData;
  expanded: boolean;
  onToggle: () => void;
  analytics: CampaignAnalytics | null | undefined;
  onViewPrompt: () => void;
  trailing?: ReactNode;
}) {
  const baseAgentName = useBaseAgentNames();
  const fmt = formatCampaign(c.name);
  return (
    <div className="border-b border-[var(--border)] last:border-b-0">
      <div className={`${CAMPAIGN_ROW_GRID} px-4 py-3 items-start hover:bg-[var(--bg-hover)]/40 transition-colors`}>
        {/* Campaign */}
        <div className="min-w-0">
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1.5 text-left min-w-0 group"
            aria-label={expanded ? "Collapse call records" : "Expand call records"}
          >
            <ChevronRight size={14} className={`text-[var(--text-3)] shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`} />
            <span className="text-sm font-semibold text-[var(--text-1)] truncate group-hover:text-blue-400 transition-colors" title={c.name}>
              {fmt.offer || fmt.display}
            </span>
          </button>
          <div className="text-[11px] text-[var(--text-3)] mt-1 flex items-center gap-1.5 flex-wrap">
            <span>{baseAgentName(c.baseAssistantId) ?? voiceName(c.voiceId, { short: true }) ?? "—"}</span>
            {c.scheduleType === "recurring" && (
              <>
                <span className="text-[var(--border-2)]">·</span>
                <span className="inline-flex items-center gap-1 text-[var(--text-2)]" title="Recurring campaign">
                  <Repeat size={10} /> recurring
                </span>
              </>
            )}
            <span className="text-[var(--border-2)]">·</span>
            <button type="button" onClick={onViewPrompt} className="text-blue-400 hover:text-blue-300 transition-colors">
              view prompt
            </button>
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

        {/* Breakdown columns */}
        <BreakdownColumn metric={c.perf.callAttempts} />
        <BreakdownColumn metric={c.perf.reached} />
        <BreakdownColumn metric={c.perf.sms} />
      </div>

      {expanded && (
        <div className="px-4 py-4 bg-[var(--bg-app)] border-t border-[var(--border)]">
          {analytics === undefined ? (
            <p className="text-xs text-[var(--text-3)] py-2">Loading campaign analytics…</p>
          ) : analytics === null ? (
            <p className="text-xs text-[var(--text-3)] py-2">No analytics available for this campaign.</p>
          ) : (
            <CampaignExpand a={analytics} />
          )}
        </div>
      )}
    </div>
  );
}
