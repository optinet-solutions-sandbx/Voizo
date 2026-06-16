// Home dashboard — the unified Voizo Dashboard (promoted from /analytics, 2026-06-15, Val's
// "one unified dashboard"). Replaces the previous Material-admin home. The old home's data
// endpoints (/api/dashboard/metrics, /api/dashboard/activity) are now unused — cleanup is a
// follow-up; the previous page is recoverable from git history if needed.
import DashboardView from "../analytics/DashboardView";

export default function DashboardPage() {
  return <DashboardView />;
}
