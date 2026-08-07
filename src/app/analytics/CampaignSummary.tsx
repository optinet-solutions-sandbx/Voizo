"use client";

// Filter-scoped summary for the Campaign Performance section (Val 2026-08-07:
// "a top-level summary like the existing ones; when filters are applied it
// reflects totals across all campaigns matching those filters"). Fed by
// summarizeRollupWindow over the SAME rollup rows the table rows are built
// from, and rendered with the SAME SegBar/MetricRow the other perf cards use —
// so it cannot disagree with either. No deltas: the scope is an arbitrary
// filter set, so there is no meaningful "previous period" to compare against.

import type { PerfMetric, TodayPerfDay } from "@/lib/dashboardAnalytics";
import { SegBar, MetricRow } from "./PerformanceCards";

const noop = () => {};

function SummaryCard({ label, metric, isSms }: { label: string; metric: PerfMetric; isSms?: boolean }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] px-5 py-4 flex flex-col">
      <div className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--text-3)] mb-2">{label}</div>
      <div className="text-[28px] leading-none font-semibold font-mono tracking-[-0.025em] text-[var(--text-1)]">
        {metric.total.toLocaleString()}
      </div>
      <div className="my-3">
        <SegBar rows={metric.rows} />
      </div>
      <div className="flex flex-col">
        {metric.rows.map((row) => (
          <div key={row.key} className="flex flex-col">
            <MetricRow row={row} showDelta={false} onOpen={noop} />
            {isSms && row.subRows?.map((sub) => (
              <MetricRow key={sub.key} row={sub} indent showDelta={false} onOpen={noop} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CampaignSummary({ perf, scopeLabel }: { perf: TodayPerfDay; scopeLabel: string }) {
  return (
    <div className="px-3.5 pt-3 pb-1">
      <div className="text-[11px] text-[var(--text-3)] mb-2">
        Summary of the campaigns listed below · {scopeLabel}
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <SummaryCard label="Call attempts" metric={perf.callAttempts} />
        <SummaryCard label="Reached" metric={perf.reached} />
        <SummaryCard label="SMS sent" metric={perf.sms} isSms />
      </div>
    </div>
  );
}
