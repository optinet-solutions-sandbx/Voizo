// Lane health (dashboard mockup, ported 2026-09-03). A LANE is a brand × country pair: what
// dials, and what breaks. Two incidents made this: the 2026-08-18 AU SIP-500 storm (connect rate
// 89.5% → 32.1%, no alert) and the 2026-08-24 CA trunk outage. The Global connect rate averages
// every market together, so a dead lane hides inside a healthy-looking number. This is the one
// place on the page that answers "which market is broken right now".
//
// The VERDICT is prod's own detectConnectCollapse rule (anomalyDetectors.ts): a lane that dialled
// at least CONNECT_COLLAPSE_MIN_DIALS and connected under CONNECT_COLLAPSE_RATE_THRESHOLD of them
// has collapsed; under the floor it is "too few to judge"; no dials is "did not dial". It is
// judged on the LAST CLOSED DAY, never on today: today is a few hours of dialling and a Canadian
// zero at 08:45Z is the night, not silence. Today is printed as figures so far, nothing inferred.
//
// Pure over the per-campaign-per-day rollup the Today route already loads. Unit-tested.

import { CONNECT_COLLAPSE_MIN_DIALS, CONNECT_COLLAPSE_RATE_THRESHOLD } from "./alerts/anomalyDetectors";
import type { CallRollupRow, DashCampaignRow } from "./dashboardAnalytics";
import { formatCampaign } from "./campaignDisplay";

export type LaneState = "collapse" | "idle" | "thin" | "ok";
export const LANE_RANK: Record<LaneState, number> = { collapse: 0, idle: 1, thin: 2, ok: 3 };
export const LANE_LABEL: Record<LaneState, string> = { collapse: "collapse", idle: "did not dial", thin: "too few to judge", ok: "ok" };

export interface LaneHealthRow {
  key: string; // `${brandKey}|${country}`
  brand: string | null; // raw cio_workspace (null = default brand); UI renders via brandLabel()
  country: string; // friendly country name, or "Unknown"
  judgedOn: string; // the closed day the verdict is for, YYYY-MM-DD
  yesterday: { dials: number; connected: number; rate: number | null };
  today: { dials: number; connected: number };
  state: LaneState;
}

/** prod's rule, lifted: rate defaults to 1 on zero dials so the predicate cannot trip on nothing. */
export function laneState(dials: number, connected: number): LaneState {
  if (dials === 0) return "idle";
  const rate = connected / dials;
  if (dials >= CONNECT_COLLAPSE_MIN_DIALS && rate < CONNECT_COLLAPSE_RATE_THRESHOLD) return "collapse";
  if (dials < CONNECT_COLLAPSE_MIN_DIALS) return "thin";
  return "ok";
}

/**
 * Fold the rollup into lanes. `judgedOn` is the last closed day (yesterday, UTC); `todayIso` is
 * today. Ghost and test campaigns are excluded by the caller's campaign list. A lane appears if it
 * dialled on EITHER day, so a lane that died overnight is still listed with its yesterday verdict
 * and a "did not dial" is the honest reading for one that stopped. Sorted worst first, then by key.
 */
export function buildLaneHealth(
  rollup: CallRollupRow[],
  campaigns: DashCampaignRow[],
  judgedOn: string,
  todayIso: string,
): LaneHealthRow[] {
  const byId = new Map(campaigns.map((c) => [c.id, c]));
  const lanes = new Map<string, LaneHealthRow>();
  for (const r of rollup) {
    if (r.day_utc !== judgedOn && r.day_utc !== todayIso) continue;
    const c = byId.get(r.campaign_id);
    if (!c) continue;
    const brand = (c.cio_workspace ?? "").trim().toLowerCase() || null;
    const country = formatCampaign(c.name).country || "Unknown";
    const key = `${brand ?? ""}|${country}`;
    const lane = lanes.get(key) ?? {
      key, brand: c.cio_workspace ?? null, country, judgedOn,
      yesterday: { dials: 0, connected: 0, rate: null }, today: { dials: 0, connected: 0 }, state: "idle" as LaneState,
    };
    const side = r.day_utc === judgedOn ? lane.yesterday : lane.today;
    side.dials += r.attempts;
    side.connected += r.connected;
    lanes.set(key, lane);
  }
  for (const lane of lanes.values()) {
    lane.yesterday.rate = lane.yesterday.dials ? lane.yesterday.connected / lane.yesterday.dials : null;
    lane.state = laneState(lane.yesterday.dials, lane.yesterday.connected);
  }
  return [...lanes.values()].sort((a, b) => LANE_RANK[a.state] - LANE_RANK[b.state] || a.key.localeCompare(b.key));
}
