"use client";

import { useState, Fragment, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { smsInFlightOf, type CampaignAnalytics, type PortfolioRollup } from "@/lib/campaignAnalytics";
import FunnelMiniBar from "./FunnelMiniBar";
import GoalSparkline from "./GoalSparkline";
import ConfidenceValue from "./ConfidenceValue";
import LeakTag from "./LeakTag";
import GoalTrustBadge from "./GoalTrustBadge";
import AnalyticsRowExpand from "./AnalyticsRowExpand";

interface AnalyticsTableProps {
  records: CampaignAnalytics[];
  portfolio: PortfolioRollup;
}

function Th({ children, alignRight }: { children?: ReactNode; alignRight?: boolean }) {
  return (
    <th className={`px-3 py-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] border-b border-[var(--border)] ${alignRight ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

export default function AnalyticsTable({ records, portfolio }: AnalyticsTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="hidden md:block overflow-x-auto">
      <p className="text-[10px] text-[var(--text-3)] px-3 pt-2">
        Conversion = wins per connected call · Yield = wins per targeted lead · grey = thin sample (let it accumulate) · click a row to deep-dive + export.
      </p>
      <table className="w-full min-w-[980px] text-sm">
        <thead>
          <tr>
            <Th>Campaign</Th>
            <Th>Date</Th>
            <Th><span title="Targeted → connected → goal, scaled to the list. Hover a bar for raw counts.">Funnel</span></Th>
            <Th alignRight><span title="Conversion — wins (goals) per connected call.">Conv.</span></Th>
            <Th alignRight><span title="Yield — wins (goals) per targeted lead.">Yield</span></Th>
            <Th><span title="The biggest drop-off stage to fix first.">Leak</span></Th>
            <Th alignRight><span title="Goals per active day.">Velocity</span></Th>
            <Th><span title="Goals per day over the last 14 days.">14-day goals</span></Th>
            <Th alignRight><span title="SMS delivered / failed (· in-flight sent count when no delivery receipts yet).">SMS</span></Th>
            <Th>Status</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {records.map((a) => {
            const isOpen = expanded === a.id;
            return (
              <Fragment key={a.id}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : a.id)}
                  className="group border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                >
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-[var(--text-1)] truncate">{a.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-3)]">{a.country}</span>
                      {a.isTest && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">TEST</span>}
                      <span className="text-[10px] text-[var(--text-3)]">{a.scheduleType}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-xs text-[var(--text-3)] whitespace-nowrap">{a.startAt ? a.startAt.slice(0, 10) : "—"}</td>
                  <td className="px-3 py-3"><FunnelMiniBar a={a} /></td>
                  <td className="px-3 py-3 text-right">
                    <span className="inline-flex items-center gap-1 justify-end">
                      <ConfidenceValue value={a.conversion} median={portfolio.medianConversion} confidence={a.confidence} />
                      <GoalTrustBadge coverage={a.goalTrustCoverage} size={11} />
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <ConfidenceValue value={a.yield} median={portfolio.medianYield} confidence={a.confidence} />
                  </td>
                  <td className="px-3 py-3"><LeakTag stage={a.biggestLeak} /></td>
                  <td className="px-3 py-3 text-right tabular-nums text-[var(--text-2)]">
                    {a.goalVelocity === null ? "—" : a.goalVelocity.toFixed(2)}
                    <span className="text-[10px] text-[var(--text-3)]">/d</span>
                  </td>
                  <td className="px-3 py-3"><GoalSparkline series={a.sparkline} /></td>
                  <td
                    className="px-3 py-3 text-right text-xs tabular-nums"
                    title={`Delivered ${a.sms.delivered} · Failed ${a.sms.failed} · In-flight (sent/queued) ${smsInFlightOf(a.sms)}\nDelivered/failed need the Mobivate delivery-receipt webhook; until it posts, sends sit in-flight.`}
                  >
                    <span className="text-emerald-400">{a.sms.delivered}</span>
                    <span className="text-[var(--text-3)]">/</span>
                    <span className="text-red-400">{a.sms.failed}</span>
                    {smsInFlightOf(a.sms) > 0 && a.sms.delivered + a.sms.failed === 0 && (
                      <span className="text-[var(--text-3)] ml-1">·{smsInFlightOf(a.sms)} sent</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs text-[var(--text-2)]">{a.status}</td>
                  <td className="px-2 py-3 text-[var(--text-3)]">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-[var(--bg-app)]">
                    <td colSpan={11} className="px-4 py-4 border-b border-[var(--border)]">
                      <AnalyticsRowExpand a={a} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
