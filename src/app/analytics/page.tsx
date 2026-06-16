// /analytics — renders the unified dashboard (also the home /dashboard). Kept as an alias
// so existing links/search to /analytics still work after the 2026-06-15 promotion to home.
import DashboardView from "./DashboardView";

export default function AnalyticsPage() {
  return <DashboardView />;
}
