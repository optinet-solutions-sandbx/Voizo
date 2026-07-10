import { ShieldCheck, ShieldAlert, ShieldX } from "lucide-react";
import { ANALYTICS_CONFIG } from "@/lib/analyticsConfig";

interface GoalTrustBadgeProps {
  coverage: number | null; // 0..1 or null
  size?: number;
}

/**
 * G5 master gate: goal_reached is populated by the async Vapi end-of-call webhook,
 * which can race/break. Red coverage = investigate the webhook BEFORE actioning the
 * goal-based numbers on that campaign (they read artificially low).
 */
export default function GoalTrustBadge({ coverage, size = 12 }: GoalTrustBadgeProps) {
  if (coverage === null) {
    return (
      <span className="inline-flex items-center gap-1 text-[var(--text-3)] text-[11px]" title="No connected calls yet">
        <ShieldAlert size={size} /> n/a
      </span>
    );
  }
  const pct = (coverage * 100).toFixed(0);
  if (coverage >= ANALYTICS_CONFIG.GOAL_TRUST_GREEN) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px]" title={`Goal-trust coverage ${pct}%`}>
        <ShieldCheck size={size} /> {pct}%
      </span>
    );
  }
  if (coverage >= ANALYTICS_CONFIG.GOAL_TRUST_AMBER) {
    return (
      <span className="inline-flex items-center gap-1 text-amber-400 text-[11px]" title={`Goal-trust coverage ${pct}%: some calls are missing a goal verdict`}>
        <ShieldAlert size={size} /> {pct}%
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-red-400 text-[11px]"
      title={`Low goal-trust coverage ${pct}%: investigate the Vapi end-of-call webhook before actioning this data`}
    >
      <ShieldX size={size} /> {pct}%
    </span>
  );
}
