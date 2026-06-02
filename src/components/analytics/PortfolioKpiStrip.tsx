import type { ReactNode } from "react";
import type { PortfolioRollup } from "@/lib/campaignAnalytics";
import GoalTrustBadge from "./GoalTrustBadge";

interface PortfolioKpiStripProps {
  portfolio: PortfolioRollup;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function money(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function Card({ label, value, sub, accent }: { label: string; value: string; sub?: ReactNode; accent?: string }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl px-5 py-4">
      <div className="text-[11px] uppercase tracking-wider font-medium text-[var(--text-3)]">{label}</div>
      <div className={`text-[26px] font-bold tabular-nums leading-tight mt-1 ${accent ?? "text-[var(--text-1)]"}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-3)] mt-1">{sub}</div>}
    </div>
  );
}

export default function PortfolioKpiStrip({ portfolio }: PortfolioKpiStripProps) {
  const totalTalkMin = portfolio.talkMinOnGoal + portfolio.talkMinOther;
  const goalPctOfTalk = totalTalkMin > 0 ? (portfolio.talkMinOnGoal / totalTalkMin) * 100 : 0;
  return (
    <section className="mb-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <Card label="Portfolio Yield" value={pct(portfolio.portfolioYield)} accent="text-violet-400" sub="goal ÷ targeted" />
        <Card label="Portfolio Conversion" value={pct(portfolio.portfolioConversion)} accent="text-emerald-400" sub="goal ÷ connected" />
        <Card
          label="Est. Spend"
          value={money(portfolio.estSpend)}
          accent="text-blue-400"
          sub={<span>est. · {portfolio.costPerGoal === null ? "—" : `${money(portfolio.costPerGoal)}/goal`}</span>}
        />
        <Card
          label="Goal Trust"
          value={pct(portfolio.goalTrustCoverage)}
          accent="text-amber-400"
          sub={<GoalTrustBadge coverage={portfolio.goalTrustCoverage} />}
        />
      </div>
      {/* Talk-time split: won vs everything-else (is spend productive?) */}
      <div className="mt-3 flex items-center gap-3 text-[11px] text-[var(--text-3)]">
        <span>Talk-time on won goals</span>
        <div className="flex-1 h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden flex">
          <div className="h-full bg-emerald-500/70" style={{ width: `${goalPctOfTalk}%` }} title={`Won: ${portfolio.talkMinOnGoal.toFixed(0)} min`} />
          <div className="h-full bg-[var(--text-3)]/30" style={{ width: `${100 - goalPctOfTalk}%` }} title={`Other: ${portfolio.talkMinOther.toFixed(0)} min`} />
        </div>
        <span className="tabular-nums">{goalPctOfTalk.toFixed(0)}%</span>
      </div>
      <p className="mt-2 text-[10px] text-[var(--text-3)]">
        Portfolio metrics exclude test + low-volume campaigns ({portfolio.includedCount} included · {portfolio.excludedTestCount} test · {portfolio.excludedLowVolumeCount} low-volume). All $ are est. proxies.
      </p>
    </section>
  );
}
