import type { CampaignAnalytics } from "@/lib/campaignAnalytics";

interface AnalyticsRowExpandProps {
  a: CampaignAnalytics;
}

// Stub — full diagnostics body lands in T13.
export default function AnalyticsRowExpand({ a }: AnalyticsRowExpandProps) {
  return <div className="text-xs text-[var(--text-3)]">Diagnostics for {a.name} — coming next.</div>;
}
