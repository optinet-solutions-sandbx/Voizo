import type { CampaignAnalytics, PortfolioRollup } from "@/lib/campaignAnalytics";
import FunnelMiniBar from "./FunnelMiniBar";
import GoalSparkline from "./GoalSparkline";
import ConfidenceValue from "./ConfidenceValue";
import LeakTag from "./LeakTag";

interface AnalyticsMobileCardsProps {
  records: CampaignAnalytics[];
  portfolio: PortfolioRollup;
}

export default function AnalyticsMobileCards({ records, portfolio }: AnalyticsMobileCardsProps) {
  return (
    <div className="md:hidden divide-y divide-[var(--border)]">
      {records.map((a) => (
        <div key={a.id} className="px-4 py-3.5">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-semibold text-[var(--text-1)] text-sm truncate">{a.name}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-3)]">{a.country}</span>
              {a.isTest && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">TEST</span>}
            </div>
            <LeakTag stage={a.biggestLeak} />
          </div>
          <div className="mb-2">
            <FunnelMiniBar a={a} />
          </div>
          <div className="grid grid-cols-3 gap-3 items-center">
            <div>
              <p className="text-[10px] text-[var(--text-3)] mb-0.5">Conv.</p>
              <ConfidenceValue value={a.conversion} median={portfolio.medianConversion} confidence={a.confidence} />
            </div>
            <div>
              <p className="text-[10px] text-[var(--text-3)] mb-0.5">Yield</p>
              <ConfidenceValue value={a.yield} median={portfolio.medianYield} confidence={a.confidence} />
            </div>
            <div className="flex justify-end">
              <GoalSparkline series={a.sparkline} width={90} height={24} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
