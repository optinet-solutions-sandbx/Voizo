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
import { substantiveUserTurnCount } from "./transcriptClassify";

// ── Input row shapes (only the columns Task 8 selects) ──────────────────────
export interface CampaignRow {
  id: string;
  name: string;
  status?: string | null;
  is_test?: boolean | null;
  source?: string | null; // 'production' | 'ghost_portal' — ghost runs are segregated from client analytics
  start_at?: string | null;
  created_at?: string | null;
  end_at?: string | null;
  campaign_type?: string | null;
  goal_target?: number | null; // campaigns_v2.goal_target — operator-set target count of goal-reached calls; NULL when unset
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
  voicemail?: boolean | null; // calls_v2.voicemail (transcript-detected); NULL = not evaluated (historical / pre-deploy)
  ended_reason?: string | null; // calls_v2.ended_reason — 'silence-timed-out' / 'customer-ended-call' drive the early-hangup proxy
  transcript?: { text?: string | null } | string | null; // calls_v2.transcript (jsonb {text}); engagement signal
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
export interface DurationBucket {
  lowerSec: number;
  upperSec: number | null; // null = open-ended top bucket; avoids Infinity-in-JSON
  count: number;
}
// Raw per-status buckets. "SMS sent" (app-wide, 2026-07-02) = delivered + sent —
// accepted by the provider or confirmed on the handset; queued/failed excluded.
// Surfaces needing an in-flight readout derive it as sent + queued explicitly.
export interface SmsCounts {
  delivered: number;
  sent: number; // accepted by the provider (no delivery receipt yet)
  queued: number; // row created, provider not yet called
  failed: number; // failed + undelivered
  byProvider: Record<string, { delivered: number; sent: number; queued: number; failed: number }>;
}

/** The app-wide "SMS sent" metric (2026-07-02): accepted by the provider or confirmed
 *  delivered. THE single formula — every UI surface derives its number from here. */
export function smsSentOf(sms: SmsCounts): number {
  return sms.delivered + sms.sent;
}

/** DLR-status readout: messages still awaiting a delivery receipt (sent) or the provider call
 *  (queued). Presentation-only derivation for the in-flight column/tooltip surfaces. */
export function smsInFlightOf(sms: SmsCounts): number {
  return sms.sent + sms.queued;
}

export interface OutcomeBreakdown {
  // Partition of REACHED human calls (connected, not voicemail; count == reach). Sums to reach.
  // ALL FOUR ARE PROXIES (labeled "est." in the UI) over existing fields — NOT a persisted
  // disposition. positive = goal_reached (SMS opt-in, upstream of a sale); declined = the call's
  // contact has outcome 'declined_offer'; earlyHangup = reached call shorter than EARLY_HANGUP_SEC
  // with no goal/decline; neutral = the remainder. See computeOne for the priority order.
  positive: number;
  declined: number;
  earlyHangup: number;
  neutral: number;
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
  // voicemail / reach (call-observability slice) — connected-gated, null-safe over evaluated calls
  voicemailConnected: number; // connected calls flagged voicemail===true
  voicemailEvaluated: number; // connected calls with a non-null voicemail flag (true|false)
  reach: number; // human-only connects = connected − voicemailConnected (unevaluated count as reached)
  goalCalls: number;
  goalNumbers: number;
  goalTarget: number | null; // operator-set target count of goals (campaigns_v2.goal_target); NULL when unset
  // connected-calls outcome breakdown — proxy partition of REACHED humans (== reach)
  outcomeBreakdown: OutcomeBreakdown;
  // rates (null = uncomputable; never NaN — G1)
  conversion: number | null;
  voicemailRate: number | null; // voicemailConnected / voicemailEvaluated (NULL until calls are evaluated)
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
  durationHistogram: DurationBucket[];
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
  isGhost: boolean; // source==='ghost_portal' — internal run, excluded from client portfolio
  includedInPortfolio: boolean; // !isGhost && !isTest && targeted>=floor && dialed>=floor
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

export function bucketDurations(durations: number[], edges: readonly number[]): DurationBucket[] {
  const buckets: DurationBucket[] = edges.map((lowerSec, i) => ({
    lowerSec,
    upperSec: i + 1 < edges.length ? edges[i + 1] : null,
    count: 0,
  }));
  if (buckets.length === 0) return buckets;
  for (const d of durations) {
    let idx = 0;
    for (let i = 0; i < edges.length; i++) {
      if (d >= edges[i]) idx = i;
      else break;
    }
    if (d < edges[0]) idx = 0; // guard stray negative
    buckets[idx].count++;
  }
  return buckets;
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
// canon (route.ts:34): a connected call is status 'completed' ('answered' is a documented
// dead bucket, never written). NOTE: a voicemail pickup also lands here as 'completed', so
// "connected" == ANSWER (incl. voicemail). Reach (human-only) needs a persisted voicemail
// signal — deferred slice. Exported as the single source of truth for the dashboard layer.
export const CONNECTED_STATUSES = new Set(["completed", "answered"]);
export const TERMINAL_NONCONNECT = new Set(["no_answer", "busy", "failed", "canceled"]);

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
  let voicemailConnected = 0; // connected calls flagged voicemail===true
  let voicemailEvaluated = 0; // connected calls with a non-null voicemail flag
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
      // Voicemail/reach (call-observability slice): only CONNECTED ('completed') calls can be a
      // voicemail. NULL = not evaluated (historical/pre-deploy) → excluded from the rate denom.
      if (c.voicemail === true) voicemailConnected++;
      if (c.voicemail != null) voicemailEvaluated++;
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

  // ── Dispositions (G2: outcome ?? 'pending'; G7: 'wrong_number' is dead, never counted as signal) ──
  const failureMix: FailureMix = { no_answer: 0, busy: 0, failed: 0, canceled: 0 };
  for (const c of calls) {
    const s = c.status ?? "";
    if (s === "no_answer") failureMix.no_answer++;
    else if (s === "busy") failureMix.busy++;
    else if (s === "failed") failureMix.failed++;
    else if (s === "canceled") failureMix.canceled++;
  }
  const nonConnectTotal = failureMix.no_answer + failureMix.busy + failureMix.failed + failureMix.canceled;

  const outcomeCounts: Record<string, number> = {};
  let neverDialed = 0;
  for (const n of numbers) {
    const o = n.outcome ?? "pending";
    outcomeCounts[o] = (outcomeCounts[o] ?? 0) + 1;
    if (!dialed.has(n.id) && (o === "pending" || o === "pending_retry")) neverDialed++;
  }

  const unreached = outcomeCounts["unreached"] ?? 0;
  const sentSms = outcomeCounts["sent_sms"] ?? 0;
  const notInterested = outcomeCounts["not_interested"] ?? 0;
  const declined = outcomeCounts["declined_offer"] ?? 0;
  const engaged = sentSms + notInterested + declined;

  const preDialLeakage: PreDialLeakage = {
    suppressed: safeDiv(outcomeCounts["suppressed"] ?? 0, targeted) ?? 0,
    removed_from_segment: safeDiv(outcomeCounts["removed_from_segment"] ?? 0, targeted) ?? 0,
    recently_called_elsewhere: safeDiv(outcomeCounts["recently_called_elsewhere"] ?? 0, targeted) ?? 0,
  };

  // ── Connected-calls outcome breakdown (PROXY — labeled "est." in the UI) ──────────────────
  // Partition the REACHED human calls (connected, voicemail!==true → count == reach) by priority:
  //   goal reached → explicit decline (contact outcome) → early hangup (< EARLY_HANGUP_SEC) → neutral.
  // Heuristics over existing fields, not a persisted sentiment. Mixing note: 'declined' joins a
  // (call-level) reached call to its (contact-level) declined_offer outcome — fine for the common
  // one-call-per-reached-contact case; documented as an estimate.
  const declinedContactIds = new Set(
    numbers.filter((n) => (n.outcome ?? "") === "declined_offer").map((n) => n.id),
  );
  const outcomeBreakdown: OutcomeBreakdown = { positive: 0, declined: 0, earlyHangup: 0, neutral: 0 };
  for (const c of calls) {
    if (!CONNECTED_STATUSES.has(c.status ?? "")) continue;
    if (c.voicemail === true) continue; // voicemail is not a reached human (keeps the sum == reach)
    if (c.goal_reached === true) { outcomeBreakdown.positive++; continue; }
    if (c.campaign_number_id && declinedContactIds.has(c.campaign_number_id)) { outcomeBreakdown.declined++; continue; }
    // Engagement-based early-hangup — MIRRORS dashboardAnalytics.deriveAttemptTag (2026-06-26).
    // Only DEFINITIVE no-conversation signals reclassify; ambiguous null/null connects stay neutral.
    const txt = typeof c.transcript === "string" ? c.transcript : (c.transcript?.text ?? "");
    const userTurns = substantiveUserTurnCount(txt);
    if (
      c.ended_reason === "silence-timed-out" ||
      (c.ended_reason === "customer-ended-call" && userTurns <= 1) ||
      (typeof c.duration_seconds === "number" && c.duration_seconds < ANALYTICS_CONFIG.EARLY_HANGUP_SEC)
    ) {
      outcomeBreakdown.earlyHangup++;
    } else {
      outcomeBreakdown.neutral++;
    }
  }

  // ── Duration / density (G2: numeric guard; only connected calls carry reliable seconds) ──
  const connectedDurations: number[] = [];
  let talkSeconds = 0;
  let talkSecondsOnGoal = 0;
  for (const c of calls) {
    const s = c.status ?? "";
    if (!CONNECTED_STATUSES.has(s)) continue;
    if (typeof c.duration_seconds === "number" && Number.isFinite(c.duration_seconds)) {
      connectedDurations.push(c.duration_seconds);
      talkSeconds += c.duration_seconds;
      if (c.goal_reached === true) talkSecondsOnGoal += c.duration_seconds;
    }
  }
  const durationMedian = median(connectedDurations);
  const durationP95 = percentile(connectedDurations, 95);
  const durationHistogram = bucketDurations(connectedDurations, ANALYTICS_CONFIG.DURATION_BUCKETS_SEC);
  const goalDensityPerMin = safeDiv(goalCalls, talkSeconds / 60);

  // ── Retry payoff: attempt index = row_number() over created_at per number (spec §7.2/§11.8) ──
  const callsByNum = new Map<string, CallRow[]>();
  for (const c of calls) {
    const k = c.campaign_number_id ?? "";
    if (!k) continue;
    let arr = callsByNum.get(k);
    if (!arr) {
      arr = [];
      callsByNum.set(k, arr);
    }
    arr.push(c);
  }
  const attemptAgg = new Map<number, { dialed: number; connected: number }>();
  for (const list of callsByNum.values()) {
    list.sort((a, b) => Date.parse(a.created_at ?? "") - Date.parse(b.created_at ?? ""));
    list.forEach((c, i) => {
      const attempt = i + 1;
      const a = attemptAgg.get(attempt) ?? { dialed: 0, connected: 0 };
      a.dialed++;
      if (CONNECTED_STATUSES.has(c.status ?? "")) a.connected++;
      attemptAgg.set(attempt, a);
    });
  }
  const retryPayoff: RetryPayoffPoint[] = [...attemptAgg.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([attempt, a]) => ({ attempt, dialed: a.dialed, connected: a.connected, connectRate: safeDiv(a.connected, a.dialed) }));

  // ── Velocity (active_days = max(1, days from startAt to min(now, end_at))) ──
  const endMs = campaign.end_at ? Math.min(now, Date.parse(campaign.end_at)) : now;
  const activeDays = Math.max(1, daysBetween(startAt ?? new Date(now).toISOString(), new Date(endMs).toISOString()));
  const goalVelocity = safeDiv(goalCalls, activeDays);

  // ── Sparkline: last SPARKLINE_DAYS UTC days, zero-filled, goals + connected per day ──
  const dayKeys: string[] = [];
  for (let i = ANALYTICS_CONFIG.SPARKLINE_DAYS - 1; i >= 0; i--) {
    dayKeys.push(new Date(now - i * 86_400_000).toISOString().slice(0, 10));
  }
  const goalsByDay: Record<string, number> = {};
  const connByDay: Record<string, number> = {};
  for (const c of calls) {
    if (!c.created_at) continue;
    const d = new Date(c.created_at).toISOString().slice(0, 10);
    if (c.goal_reached === true) goalsByDay[d] = (goalsByDay[d] ?? 0) + 1;
    if (CONNECTED_STATUSES.has(c.status ?? "")) connByDay[d] = (connByDay[d] ?? 0) + 1;
  }
  const sparkline: SparklinePoint[] = dayKeys.map((d) => ({ date: d, goals: goalsByDay[d] ?? 0, connected: connByDay[d] ?? 0 }));

  // ── SMS (raw buckets: delivered / sent / queued / failed = failed+undelivered) ──
  const sms: SmsCounts = { delivered: 0, sent: 0, queued: 0, failed: 0, byProvider: {} };
  for (const m of acc.sms) {
    const provider = m.provider ?? "unknown";
    const bucket = (sms.byProvider[provider] ??= { delivered: 0, sent: 0, queued: 0, failed: 0 });
    const st = m.status ?? "";
    if (st === "delivered") {
      sms.delivered++;
      bucket.delivered++;
    } else if (st === "sent") {
      sms.sent++;
      bucket.sent++;
    } else if (st === "queued") {
      sms.queued++;
      bucket.queued++;
    } else if (st === "failed" || st === "undelivered") {
      sms.failed++;
      bucket.failed++;
    }
  }

  // ── Goal-trust coverage (G5): among connected calls, share with goal_reached !== null ──
  let goalReachedNullCount = 0;
  let connectedWithTrust = 0;
  for (const c of calls) {
    if (!CONNECTED_STATUSES.has(c.status ?? "")) continue;
    if (c.goal_reached === null || c.goal_reached === undefined) goalReachedNullCount++;
    else connectedWithTrust++;
  }
  const goalTrustCoverage = safeDiv(connectedWithTrust, connected);

  // ── Confidence (G4): n = connected ──
  const confidence: Confidence =
    connected < ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN
      ? "thin"
      : connected < ANALYTICS_CONFIG.SAMPLE_FLOOR_FULL
        ? "half"
        : "full";

  // ── Portfolio inclusion (G3): non-ghost + non-test + meets BOTH volume floors ──
  const isGhost = campaign.source === "ghost_portal";
  const includedInPortfolio =
    !isGhost &&
    campaign.is_test !== true &&
    targeted >= ANALYTICS_CONFIG.VOLUME_FLOOR_TARGETED &&
    dialed.size >= ANALYTICS_CONFIG.VOLUME_FLOOR_DIALED;

  // ── Biggest leak (only on included, volume-floored data; else 'none') ──
  let biggestLeak: LeakStage = "none";
  if (includedInPortfolio) {
    const preDialCount =
      (outcomeCounts["suppressed"] ?? 0) +
      (outcomeCounts["removed_from_segment"] ?? 0) +
      (outcomeCounts["recently_called_elsewhere"] ?? 0);
    // The four §7.2 candidate drop magnitudes (lead counts), each clamped ≥0. goalNums is
    // connected-gated so connectedNums ⊇ goalNums; clamp is defensive. argmax = the leak.
    const drops: Array<[LeakStage, number]> = [
      ["never_dialed", Math.max(0, neverDialed)],
      ["pre_dial_hygiene", Math.max(0, preDialCount)],
      ["reachability", Math.max(0, dialed.size - connectedNums.size)],
      ["conversion", Math.max(0, connectedNums.size - goalNums.size)],
    ];
    drops.sort((a, b) => b[1] - a[1]);
    biggestLeak = drops[0][1] > 0 ? drops[0][0] : "none";
  }

  return {
    id,
    name: campaign.name,
    country: parseCountryToken(campaign.name),
    scheduleType: campaign.campaign_type === "recurring" ? "recurring" : "fixed",
    isTest: campaign.is_test === true,
    isGhost,
    status: campaign.status ?? "draft",
    startAt,
    targeted,
    dialedNumbers: dialed.size,
    connectedNumbers: connectedNums.size,
    totalCalls,
    connected,
    voicemailConnected,
    voicemailEvaluated,
    reach: connected - voicemailConnected,
    goalCalls,
    goalNumbers: goalNums.size,
    goalTarget: campaign.goal_target ?? null,
    outcomeBreakdown,
    conversion: safeDiv(goalCalls, connected),
    voicemailRate: safeDiv(voicemailConnected, voicemailEvaluated),
    yield: safeDiv(goalNums.size, targeted),
    connectRate: safeDiv(connected, terminal),
    reachability: safeDiv(connectedNums.size, dialed.size),
    neverDialedShare: safeDiv(neverDialed, targeted),
    exhaustionRate: safeDiv(unreached, targeted), // primary denominator (= targeted); spec §7.2's "+ alt denom excluding pending/in_progress" is a deferred Phase-1.x refinement
    activeDeclineRate: safeDiv(notInterested + declined, engaged),
    preDialLeakage,
    failureMix,
    nonConnectTotal,
    durationMedian,
    durationP95,
    durationHistogram,
    talkSeconds,
    talkSecondsOnGoal,
    goalDensityPerMin,
    retryPayoff,
    activeDays,
    goalVelocity,
    sparkline,
    sms,
    goalTrustCoverage,
    goalReachedNullCount,
    confidence,
    biggestLeak,
    includedInPortfolio,
  };
}

export function computePortfolio(records: CampaignAnalytics[]): PortfolioRollup {
  // Ghost (source='ghost_portal') runs are segregated from EVERY client-facing
  // rollup — including the goal-trust gate (nonTest), where a LIVE ghost run
  // (is_test=false) would otherwise leak. includedInPortfolio already excludes them.
  const included = records.filter((r) => r.includedInPortfolio);
  const nonTest = records.filter((r) => !r.isTest && !r.isGhost);
  const excludedTestCount = records.filter((r) => r.isTest).length;
  const excludedLowVolumeCount = records.filter((r) => !r.isTest && !r.isGhost && !r.includedInPortfolio).length;

  let goalCalls = 0,
    connected = 0,
    goalNumbers = 0,
    targeted = 0;
  let talkMinOnGoal = 0,
    talkMinOther = 0;
  for (const r of included) {
    goalCalls += r.goalCalls;
    connected += r.connected;
    goalNumbers += r.goalNumbers;
    targeted += r.targeted;
    talkMinOnGoal += r.talkSecondsOnGoal / 60;
    talkMinOther += (r.talkSeconds - r.talkSecondsOnGoal) / 60;
  }

  // G5: Goal-Trust is an app-wide webhook-health gate — computed over ALL non-test
  // campaigns (NOT volume-floored), so a webhook outage that currently only shows on
  // small/new campaigns still trips the badge (spec §6.6). connected-with-non-null is
  // reconstructed as connected − goalReachedNullCount (computeOne partitions connected
  // calls into exactly null vs non-null).
  let connectedWithTrust = 0,
    connectedTotalForTrust = 0;
  for (const r of nonTest) {
    connectedTotalForTrust += r.connected;
    connectedWithTrust += r.connected - r.goalReachedNullCount;
  }

  const estSpend = (talkMinOnGoal + talkMinOther) * CONFIG_RATE_PER_MIN;

  // G4: medians over included AND non-thin, non-null values only.
  const convVals = included.filter((r) => r.confidence !== "thin" && r.conversion !== null).map((r) => r.conversion as number);
  const yieldVals = included.filter((r) => r.confidence !== "thin" && r.yield !== null).map((r) => r.yield as number);

  return {
    portfolioYield: safeDiv(goalNumbers, targeted),
    portfolioConversion: safeDiv(goalCalls, connected),
    goalTrustCoverage: safeDiv(connectedWithTrust, connectedTotalForTrust),
    estSpend,
    costPerGoal: safeDiv(estSpend, goalCalls),
    talkMinOnGoal,
    talkMinOther,
    medianConversion: median(convVals),
    medianYield: median(yieldVals),
    includedCount: included.length,
    excludedTestCount,
    excludedLowVolumeCount,
  };
}

// Re-export so callers have one import site.
export { ANALYTICS_CONFIG, CONFIG_RATE_PER_MIN };
