// Home dashboard — the unified Voizo Dashboard (promoted from /analytics, 2026-06-15, Val's
// "one unified dashboard"). Replaces the previous Material-admin home (recoverable from git
// history). NOTE: /api/dashboard/activity is NOT dead — the /activity page consumes it;
// /api/dashboard/metrics is gone. (Corrected 2026-08-05; the old comment claimed both unused.)
import DashboardView from "../analytics/DashboardView";

export default function DashboardPage() {
  return <DashboardView />;
}
