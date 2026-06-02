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

// ── Aggregation ─────────────────────────────────────────────────────────────
const CONNECTED_STATUSES = new Set(["completed", "answered"]); // canon (route.ts:34); 'answered' never written
const TERMINAL_NONCONNECT = new Set(["no_answer", "busy", "failed", "canceled"]);

interface Acc {
  campaign: CampaignRow;
  numbers: NumberRow[];
  calls: CallRow[];
  sms: SmsRow[];
}

export function computeCampaignAnalytics(input: AnalyticsInput): Record<string, CampaignAnalytics> {
  // Bucket rows by campaign id (single pass each).
  const byId = new Map<string, Acc>();
  for (const c of input.campaigns) byId.set(c.id, { campaign: c, numbers: [], calls: [], sms: [] });
  for (const n of input.numbers) byId.get(n.campaign_id)?.numbers.push(n);
  for (const c of input.calls) byId.get(c.campaign_id)?.calls.push(c);
  for (const m of input.sms) byId.get(m.campaign_id)?.sms.push(m);

  const out: Record<string, CampaignAnalytics> = {};
  for (const [id, acc] of byId) {
    out[id] = computeOne(id, acc, input.now);
  }
  return out;
}

function computeOne(id: string, acc: Acc, now: number): CampaignAnalytics {
  const { campaign, numbers, calls } = acc;

  const targeted = numbers.length;
  const totalCalls = calls.length;

  let connected = 0;
  let goalCalls = 0;
  const dialed = new Set<string>();
  const connectedNums = new Set<string>();
  const goalNums = new Set<string>();

  for (const c of calls) {
    const status = c.status ?? "";
    const numId = c.campaign_number_id ?? "";
    if (numId) dialed.add(numId);
    const isConnected = CONNECTED_STATUSES.has(status);
    if (isConnected) {
      connected++;
      if (numId) connectedNums.add(numId);
      // goalNumbers is gated to connected calls so connectedNums ⊇ goalNums by construction
      // (keeps the conversion-leak drop in Task 7 non-negative). goal on a non-connected
      // row would be a data anomaly; goalCalls below still counts every goal_reached row.
      if (c.goal_reached === true && numId) goalNums.add(numId);
    }
    if (c.goal_reached === true) {
      goalCalls++; // G2: strict === true only. NULL/false excluded.
    }
  }

  // ConnectRate denominator excludes in-flight (initiated/ringing/in_progress) and dead buckets.
  let terminal = 0;
  for (const c of calls) {
    const s = c.status ?? "";
    if (CONNECTED_STATUSES.has(s) || TERMINAL_NONCONNECT.has(s)) terminal++;
  }

  const startAt = (campaign.start_at ?? campaign.created_at) ?? null;

  return {
    id,
    name: campaign.name,
    country: parseCountryToken(campaign.name),
    scheduleType: campaign.campaign_type === "recurring" ? "recurring" : "fixed",
    isTest: campaign.is_test === true,
    status: campaign.status ?? "draft",
    startAt,
    targeted,
    dialedNumbers: dialed.size,
    connectedNumbers: connectedNums.size,
    totalCalls,
    connected,
    goalCalls,
    goalNumbers: goalNums.size,
    conversion: safeDiv(goalCalls, connected),
    yield: safeDiv(goalNums.size, targeted),
    connectRate: safeDiv(connected, terminal),
    reachability: safeDiv(connectedNums.size, dialed.size),
    // ── filled in by later tasks ──
    neverDialedShare: null,
    exhaustionRate: null,
    activeDeclineRate: null,
    preDialLeakage: { suppressed: 0, removed_from_segment: 0, recently_called_elsewhere: 0 },
    failureMix: { no_answer: 0, busy: 0, failed: 0, canceled: 0 },
    nonConnectTotal: 0,
    durationMedian: null,
    durationP95: null,
    talkSeconds: 0,
    talkSecondsOnGoal: 0,
    goalDensityPerMin: null,
    retryPayoff: [],
    activeDays: 1,
    goalVelocity: null,
    sparkline: [],
    sms: { delivered: 0, failed: 0, inFlight: 0, byProvider: {} },
    goalTrustCoverage: null,
    goalReachedNullCount: 0,
    confidence: "thin",
    biggestLeak: "none",
    includedInPortfolio: false,
  };
}

// Re-export so callers have one import site.
export { ANALYTICS_CONFIG, CONFIG_RATE_PER_MIN };
