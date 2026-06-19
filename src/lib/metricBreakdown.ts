// Pure region × time breakdown behind the dashboard metric drawer (Feature 2 of the
// dashboard-metric-drilldown spec). For each region (L7_<CC>_ name token) and each window
// (today / yesterday / rolling last-7d) it tallies calls / connected / goals / messages and
// derives the rates. Reuses campaignAnalytics conventions so the numbers reconcile:
//   - connected = status ∈ CONNECTED_STATUSES (== 'completed', incl. voicemail)
//   - connectRate = connected / calls   (the DASHBOARD-CARD definition: 49 of 54, not /terminal)
//   - successRate = goals / connected
//   - ghost (source='ghost_portal') + test campaigns excluded (same as computeToday)
//   - UTC day boundaries for today/yesterday (matches computeToday); last7d is rolling [now-7d, now]
// No I/O; `now` is injected so it stays pure + testable.
import { parseCountryToken, CONNECTED_STATUSES, safeDiv } from "./campaignAnalytics";

const MS_PER_DAY = 86_400_000;

export interface BreakdownCallRow {
  campaign_id: string;
  status?: string | null;
  goal_reached?: boolean | null;
  created_at?: string | null;
}
export interface BreakdownSmsRow {
  campaign_id: string;
  created_at?: string | null;
}
export interface BreakdownCampaignRow {
  id: string;
  name: string;
  source?: string | null;
  is_test?: boolean | null;
}
export interface BreakdownInput {
  now: number;
  campaigns: BreakdownCampaignRow[];
  calls: BreakdownCallRow[];
  sms: BreakdownSmsRow[];
}

export interface BreakdownCell {
  calls: number;
  connected: number;
  goals: number;
  messages: number;
  connectRate: number | null; // connected / calls
  successRate: number | null; // goals / connected
}
export interface RegionRow {
  region: string; // 'AU' | 'CA' | 'UNKNOWN' | 'ALL'
  today: BreakdownCell;
  yesterday: BreakdownCell;
  last7d: BreakdownCell;
}
export interface MetricBreakdown {
  regions: RegionRow[]; // busiest (last7d calls) first
  total: RegionRow; // region 'ALL'
}

type RawCell = { calls: number; connected: number; goals: number; messages: number };
type RawRow = { today: RawCell; yesterday: RawCell; last7d: RawCell };
const rawCell = (): RawCell => ({ calls: 0, connected: 0, goals: 0, messages: 0 });
const rawRow = (): RawRow => ({ today: rawCell(), yesterday: rawCell(), last7d: rawCell() });

export function computeMetricBreakdown(input: BreakdownInput): MetricBreakdown {
  const { now, campaigns, calls, sms } = input;
  const index = new Map(campaigns.map((c) => [c.id, c]));
  const d = new Date(now);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const yesterdayStart = todayStart - MS_PER_DAY;
  const last7dStart = now - 7 * MS_PER_DAY;

  const byRegion = new Map<string, RawRow>();
  const total = rawRow();
  const get = (region: string): RawRow => {
    let r = byRegion.get(region);
    if (!r) { r = rawRow(); byRegion.set(region, r); }
    return r;
  };
  const windowsFor = (t: number): (keyof RawRow)[] => {
    const w: (keyof RawRow)[] = [];
    if (t >= todayStart && t <= now) w.push("today");
    if (t >= yesterdayStart && t < todayStart) w.push("yesterday");
    if (t >= last7dStart && t <= now) w.push("last7d");
    return w;
  };
  // null = ghost / test / orphan campaign → excluded
  const liveCampaign = (campaignId: string) => {
    const c = index.get(campaignId);
    if (!c || c.source === "ghost_portal" || c.is_test === true) return null;
    return c;
  };

  for (const c of calls) {
    const camp = liveCampaign(c.campaign_id);
    if (!camp) continue;
    const t = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const region = parseCountryToken(camp.name);
    const conn = CONNECTED_STATUSES.has(c.status ?? "") ? 1 : 0;
    const goal = c.goal_reached === true ? 1 : 0;
    const rr = get(region);
    for (const w of windowsFor(t)) {
      rr[w].calls++; rr[w].connected += conn; rr[w].goals += goal;
      total[w].calls++; total[w].connected += conn; total[w].goals += goal;
    }
  }

  for (const m of sms) {
    const camp = liveCampaign(m.campaign_id);
    if (!camp) continue;
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const region = parseCountryToken(camp.name);
    const rr = get(region);
    for (const w of windowsFor(t)) { rr[w].messages++; total[w].messages++; }
  }

  const toCell = (r: RawCell): BreakdownCell => ({
    ...r,
    connectRate: safeDiv(r.connected, r.calls),
    successRate: safeDiv(r.goals, r.connected),
  });
  const toRow = (region: string, r: RawRow): RegionRow => ({
    region,
    today: toCell(r.today),
    yesterday: toCell(r.yesterday),
    last7d: toCell(r.last7d),
  });

  const regions = [...byRegion.entries()]
    .map(([region, r]) => toRow(region, r))
    .sort((a, b) => b.last7d.calls - a.last7d.calls || a.region.localeCompare(b.region));

  return { regions, total: toRow("ALL", total) };
}
