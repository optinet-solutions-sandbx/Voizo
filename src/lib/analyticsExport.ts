import type { CampaignAnalytics, PortfolioRollup } from "./campaignAnalytics";
import { csvCell, CSV_BOM } from "./download";

/** Formula legend, shared by CSV header + JSON _definitions, so an exported file is self-documenting. */
export const ANALYTICS_DEFINITIONS: Record<string, string> = {
  conversion: "goalCalls / connected",
  yield: "distinct goalNumbers / targeted",
  connectRate: "connected / (connected + no_answer + busy + failed + canceled)",
  reachability: "distinct connectedNumbers / distinct dialedNumbers",
  neverDialedShare: "numbers (no call, outcome pending/pending_retry) / targeted",
  exhaustionRate: "outcome=unreached / targeted",
  activeDeclineRate: "(not_interested + declined_offer) / engaged",
  goalDensityPerMin: "goalCalls / (talk-seconds / 60)",
  goalVelocityPerDay: "goalCalls / active days",
  goalTrustCoverage: "connected with goal_reached not null / connected",
  connected: "calls with status in (completed, answered) — no min-duration floor",
  goal: "calls with goal_reached === true",
  reach: "connected − voicemailConnected (unevaluated connects count as reached)",
  voicemailRate: "voicemailConnected / voicemailEvaluated (null until evaluated)",
  goalTarget: "operator-set target goal count (campaigns_v2.goal_target; null = unset)",
  outcomePositive: "est. — reached calls with goal_reached (agreed / opted in)",
  outcomeNeutral: "est. — reached calls with no clear signal (the remainder)",
  outcomeDeclined: "est. — reached calls whose contact outcome = declined_offer",
  outcomeEarlyHangup: "est. — reached calls under 15s with no goal/decline",
};

// [csvHeader, accessor] — single source of truth for both column order and values.
const COLUMNS: Array<[string, (a: CampaignAnalytics) => string | number | null]> = [
  ["campaign", (a) => a.name],
  ["country", (a) => a.country],
  ["scheduleType", (a) => a.scheduleType],
  ["isTest", (a) => String(a.isTest)],
  ["status", (a) => a.status],
  ["startAt", (a) => a.startAt],
  ["targeted", (a) => a.targeted],
  ["totalCalls", (a) => a.totalCalls],
  ["connected", (a) => a.connected],
  ["reach", (a) => a.reach],
  ["voicemailConnected", (a) => a.voicemailConnected],
  ["voicemailEvaluated", (a) => a.voicemailEvaluated],
  ["voicemailRate", (a) => a.voicemailRate],
  ["dialedNumbers", (a) => a.dialedNumbers],
  ["connectedNumbers", (a) => a.connectedNumbers],
  ["goalCalls", (a) => a.goalCalls],
  ["goalNumbers", (a) => a.goalNumbers],
  ["goalTarget", (a) => a.goalTarget],
  ["conversion", (a) => a.conversion],
  ["yield", (a) => a.yield],
  ["connectRate", (a) => a.connectRate],
  ["reachability", (a) => a.reachability],
  ["neverDialedShare", (a) => a.neverDialedShare],
  ["exhaustionRate", (a) => a.exhaustionRate],
  ["activeDeclineRate", (a) => a.activeDeclineRate],
  ["outcomePositive", (a) => a.outcomeBreakdown.positive],
  ["outcomeNeutral", (a) => a.outcomeBreakdown.neutral],
  ["outcomeDeclined", (a) => a.outcomeBreakdown.declined],
  ["outcomeEarlyHangup", (a) => a.outcomeBreakdown.earlyHangup],
  ["goalDensityPerMin", (a) => a.goalDensityPerMin],
  ["durationMedianSec", (a) => a.durationMedian],
  ["durationP95Sec", (a) => a.durationP95],
  ["goalVelocityPerDay", (a) => a.goalVelocity],
  ["goalTrustCoverage", (a) => a.goalTrustCoverage],
  ["goalReachedNullCount", (a) => a.goalReachedNullCount],
  ["confidence", (a) => a.confidence],
  ["biggestLeak", (a) => a.biggestLeak],
  ["includedInPortfolio", (a) => String(a.includedInPortfolio)],
  ["smsDelivered", (a) => a.sms.delivered],
  ["smsFailed", (a) => a.sms.failed],
  ["smsInFlight", (a) => a.sms.inFlight],
];

/** Aggregation-only CSV (counts + rates + a definitions comment header). Excel-safe + Claude-readable. */
export function buildAnalyticsCsv(records: CampaignAnalytics[]): string {
  const defs = Object.entries(ANALYTICS_DEFINITIONS).map(([k, v]) => `# ${k} = ${v}`);
  const header = COLUMNS.map(([name]) => csvCell(name)).join(",");
  const rows = records.map((a) => COLUMNS.map(([, get]) => csvCell(get(a))).join(","));
  return CSV_BOM + defs.join("\r\n") + "\r\n" + [header, ...rows].join("\r\n") + "\r\n";
}

/** Aggregation-only JSON; portfolio is included for bulk exports. stampNote injected by the caller (purity). */
export function buildAnalyticsJson(
  records: CampaignAnalytics[],
  stampNote: string,
  portfolio?: PortfolioRollup,
): string {
  return JSON.stringify(
    { generatedAtNote: stampNote, _definitions: ANALYTICS_DEFINITIONS, portfolio: portfolio ?? null, campaigns: records },
    null,
    2,
  );
}
