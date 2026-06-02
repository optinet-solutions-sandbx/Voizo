/**
 * Pure, React-free aggregation for the Campaigns Analytics view.
 * Input: the row sets the Campaigns page already fetches (campaigns, numbers,
 * calls) + one new SMS set. Output: a typed per-campaign record map and a
 * portfolio rollup. No I/O, no Date dependency beyond the caller-supplied `now`.
 *
 * Hand-typed because the Supabase browser client is untyped (gotcha memory).
 * Dead buckets (NEVER key a metric on these): calls_v2.status 'voicemail'/'answered'
 * and campaign_numbers_v2.outcome 'wrong_number' are never written by any code path.
 */
import { ANALYTICS_CONFIG, CONFIG_RATE_PER_MIN } from "./analyticsConfig";

// ── Input row shapes (only the columns Task 8 selects) ──────────────────────
export interface CampaignRow {
  id: string;
  name: string;
  status?: string | null;
  is_test?: boolean | null;
  start_at?: string | null;
  created_at?: string | null;
  end_at?: string | null;
  campaign_type?: string | null;
}
export interface NumberRow {
  id: string;
  campaign_id: string;
  outcome?: string | null;
  created_at?: string | null;
  attempt_count?: number | null; // reserved — NOT used in Phase 1 (retry index = row_number over calls created_at); not fetched
}
export interface CallRow {
  campaign_id: string;
  campaign_number_id?: string | null;
  status?: string | null;
  goal_reached?: boolean | null;
  duration_seconds?: number | null;
  created_at?: string | null;
}
export interface SmsRow {
  campaign_id: string;
  status?: string | null;
  provider?: string | null;
}
export interface AnalyticsInput {
  campaigns: CampaignRow[];
  numbers: NumberRow[];
  calls: CallRow[];
  sms: SmsRow[];
  /** ms epoch "now", injected by the caller (Date.now()) so the module stays pure/testable. */
  now: number;
}

// ── Output shapes (LOCKED — components consume these verbatim) ──────────────
export type Confidence = "thin" | "half" | "full";
export type ScheduleType = "fixed" | "recurring";
export type LeakStage = "never_dialed" | "pre_dial_hygiene" | "reachability" | "conversion" | "none";

export interface FailureMix {
  no_answer: number;
  busy: number;
  failed: number;
  canceled: number;
}
export interface PreDialLeakage {
  suppressed: number; // share of targeted
  removed_from_segment: number;
  recently_called_elsewhere: number;
}
export interface RetryPayoffPoint {
  attempt: number; // 1-based
  dialed: number;
  connected: number;
  connectRate: number | null;
}
export interface SparklinePoint {
  date: string; // YYYY-MM-DD (UTC)
  goals: number;
  connected: number;
}
export interface SmsCounts {
  delivered: number;
  failed: number; // failed + undelivered
  inFlight: number; // queued + sent
  byProvider: Record<string, { delivered: number; failed: number; inFlight: number }>;
}

export interface CampaignAnalytics {
  id: string;
  name: string;
  country: string; // 2-letter or 'UNKNOWN'
  scheduleType: ScheduleType;
  isTest: boolean;
  status: string;
  startAt: string | null; // COALESCE(start_at, created_at)
  // funnel counts
  targeted: number;
  dialedNumbers: number; // distinct campaign_number_id present in calls
  connectedNumbers: number; // distinct campaign_number_id with a connected call
  totalCalls: number;
  connected: number;
  goalCalls: number;
  goalNumbers: number;
  // rates (null = uncomputable; never NaN — G1)
  conversion: number | null;
  yield: number | null;
  connectRate: number | null;
  reachability: number | null;
  neverDialedShare: number | null;
  exhaustionRate: number | null;
  activeDeclineRate: number | null;
  preDialLeakage: PreDialLeakage;
  failureMix: FailureMix;
  nonConnectTotal: number;
  // duration / density
  durationMedian: number | null; // seconds, over completed non-null
  durationP95: number | null;
  talkSeconds: number; // Σ duration_seconds over connected non-null
  talkSecondsOnGoal: number;
  goalDensityPerMin: number | null;
  // retry / velocity / trend
  retryPayoff: RetryPayoffPoint[];
  activeDays: number;
  goalVelocity: number | null; // goals / activeDays
  sparkline: SparklinePoint[]; // length SPARKLINE_DAYS, zero-filled, oldest→newest
  // sms
  sms: SmsCounts;
  // trust / confidence / triage
  goalTrustCoverage: number | null;
  goalReachedNullCount: number; // connected calls with goal_reached === null
  confidence: Confidence;
  biggestLeak: LeakStage;
  includedInPortfolio: boolean; // !isTest && targeted>=floor && dialed>=floor
}

export interface PortfolioRollup {
  portfolioYield: number | null;
  portfolioConversion: number | null;
  goalTrustCoverage: number | null;
  estSpend: number; // talkMin * CONFIG_RATE_PER_MIN
  costPerGoal: number | null;
  talkMinOnGoal: number;
  talkMinOther: number;
  medianConversion: number | null;
  medianYield: number | null;
  includedCount: number;
  excludedTestCount: number;
  excludedLowVolumeCount: number;
}

// ── Helpers (G1 lives here) ─────────────────────────────────────────────────
export function safeDiv(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length); // nearest-rank
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const COUNTRY_TOKEN = /(?:^|[_\s])([A-Z]{2})(?=[_\s])/;
export function parseCountryToken(name: string): string {
  const m = (name ?? "").match(COUNTRY_TOKEN);
  return m ? m[1] : "UNKNOWN";
}

export function daysBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

// Re-export so callers have one import site.
export { ANALYTICS_CONFIG, CONFIG_RATE_PER_MIN };
