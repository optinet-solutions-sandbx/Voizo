import type { CampaignAnalytics } from "@/lib/campaignAnalytics";

interface FunnelMiniBarProps {
  a: CampaignAnalytics;
}

/** One ~120px stacked bar scaled to targeted: connected-numbers band under, goal-numbers band over. */
export default function FunnelMiniBar({ a }: FunnelMiniBarProps) {
  const targeted = Math.max(a.targeted, 1); // guard div-by-zero
  const connectedPct = Math.min(100, (a.connectedNumbers / targeted) * 100);
  const goalPct = Math.min(100, (a.goalNumbers / targeted) * 100);
  const conv = a.conversion === null ? "—" : `${(a.conversion * 100).toFixed(1)}%`;
  const yld = a.yield === null ? "—" : `${(a.yield * 100).toFixed(1)}%`;
  return (
    <div
      className="w-[120px] h-2.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden relative"
      title={`Targeted ${a.targeted} · Connected (numbers) ${a.connectedNumbers} · Goal (numbers) ${a.goalNumbers}\nConversion ${conv} · Yield ${yld}\nConnected = completed; no min-duration floor (2s answer-drops count)`}
    >
      <div className="absolute inset-y-0 left-0 bg-primary/40" style={{ width: `${connectedPct}%` }} />
      <div className="absolute inset-y-0 left-0 bg-emerald-500/80" style={{ width: `${goalPct}%` }} />
    </div>
  );
}
