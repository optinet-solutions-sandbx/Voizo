"use client";

import type { ReactNode } from "react";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import FunnelWaterfall from "./FunnelWaterfall";
import DurationHistogram from "./DurationHistogram";
import FailureMixBar from "./FailureMixBar";
import RetryPayoffBar from "./RetryPayoffBar";

interface AnalyticsRowExpandProps {
  a: CampaignAnalytics;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function secs(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(0)}s`;
}

function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">{label}</div>
      <div className="text-sm font-semibold text-[var(--text-1)] tabular-nums">{value}</div>
    </div>
  );
}

export default function AnalyticsRowExpand({ a }: AnalyticsRowExpandProps) {
  return (
    <div className="space-y-4">
      {/* Deep-dive charts (2×2) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <FunnelWaterfall a={a} />
        <DurationHistogram a={a} />
        <FailureMixBar a={a} />
        <RetryPayoffBar a={a} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
        <Metric label="Connect Rate" value={pct(a.connectRate)} hint="connected ÷ terminal calls (excludes in-flight); no min-duration floor, so 2s answer-drops count" />
        <Metric label="Reachability" value={pct(a.reachability)} hint="distinct connected numbers ÷ distinct dialed numbers" />
        <Metric label="Never-Dialed" value={pct(a.neverDialedShare)} hint="numbers with no call AND outcome pending/pending_retry ÷ targeted" />
        <Metric label="Exhaustion" value={pct(a.exhaustionRate)} hint="outcome=unreached ÷ targeted" />
        <Metric label="Active-Decline" value={pct(a.activeDeclineRate)} hint="(not_interested + declined_offer) ÷ engaged (incl. sent_sms)" />
        <Metric label="Goal Density" value={a.goalDensityPerMin === null ? "—" : `${a.goalDensityPerMin.toFixed(3)}/min`} hint="goals ÷ talk-minutes" />
        <Metric label="Median dur." value={secs(a.durationMedian)} hint="median connected-call duration" />
        <Metric label="p95 dur." value={secs(a.durationP95)} hint="p95 ≫ median = runaway/stuck calls" />
        <Metric
          label="Goal-trust"
          value={`${pct(a.goalTrustCoverage)}${a.goalReachedNullCount > 0 ? ` (${a.goalReachedNullCount} NULL)` : ""}`}
          hint="connected calls with goal_reached not null ÷ connected"
        />
      </div>

      {/* Non-connect failure mix */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">Non-Connect Failure Mix</div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">no_answer {a.failureMix.no_answer}</span>
          <span className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">busy {a.failureMix.busy}</span>
          <span className="px-2 py-0.5 rounded bg-red-500/10 text-red-400">failed {a.failureMix.failed}</span>
          <span className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">canceled {a.failureMix.canceled}</span>
        </div>
      </div>

      {/* Pre-dial leakage (often ~0 — written only on segment refresh/resume; spec §11.9) */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">
          Pre-Dial Leakage <span className="normal-case text-[var(--text-3)]">(may read ~0 if hygiene never ran)</span>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">suppressed {pct(a.preDialLeakage.suppressed)}</span>
          <span className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">removed {pct(a.preDialLeakage.removed_from_segment)}</span>
          <span className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">recent-elsewhere {pct(a.preDialLeakage.recently_called_elsewhere)}</span>
        </div>
      </div>

      {/* Retry payoff (first 3 attempts; later N survivorship-biased — spec §11.8) */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-1">Retry Payoff by attempt</div>
        <div className="flex flex-wrap gap-2 text-xs">
          {a.retryPayoff.slice(0, 3).map((p) => (
            <span key={p.attempt} className="px-2 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">
              #{p.attempt}: {pct(p.connectRate)} ({p.connected}/{p.dialed})
            </span>
          ))}
          {a.retryPayoff.length > 3 && <span className="text-[var(--text-3)]">+{a.retryPayoff.length - 3} more (conditional)</span>}
          {a.retryPayoff.length === 0 && <span className="text-[var(--text-3)]">—</span>}
        </div>
      </div>

    </div>
  );
}
