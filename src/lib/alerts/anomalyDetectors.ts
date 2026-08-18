// src/lib/alerts/anomalyDetectors.ts
//
// VOZ-279 platform-wide anomaly detectors, run once per scheduler tick over
// the most recent calls (30-min window, newest-1000 sample — share-based
// thresholds are deliberately clamp-safe at storm volume).
//
// Detector A — AI pipeline burst: the 08-02 OpenAI quota death produced
// ended_reason='pipeline-error-openai-429-exceeded-quota' on 75.6% of calls
// in-window, while the healthy base rate is 0.0% (probe 2026-08-04). A null
// ended_reason means the call never reached Vapi (e.g. CALL_REJECTED) and
// must NOT count toward either side of the share.
//
// Detector B — connect collapse: platform-wide connect share below a floor
// no healthy 30-min bucket approaches. Catches trunk/CID degradation spread
// across campaigns that never hits the per-campaign 15-straight reject
// breaker (rejectBreaker.ts).
//
// Floor raised 0.20 -> 0.50 on 2026-08-18 (SquareTalk AU landline SIP-500
// outage). At 0.20 this predicate tripped in exactly ONE 30-min bucket that
// day — 07:00Z, 46 dials, 4.3% — hours after ~450 dials had already been
// refused. Replaying it over every real 30-min bucket since 08-13 measured:
//   healthy baseline (08-13..08-14, 18 buckets >=20 dials): min 57.5%,
//     p10 73.4%, median 90.6%
//   outage day 08-18: 32.1% platform-wide
// So 0.50 is below every healthy bucket observed (zero false positives in
// that baseline) and catches 08-18 in its FIRST window instead of its fifth;
// it would also have flagged 08-15 07:30Z (49.0%) and 08-17 06:30Z (43.9%),
// three days early. 0.60 was rejected: it false-positives on the healthy
// 08-14 05:00Z bucket (57.5%). Thin baseline (18 buckets / 2 days) — treat as
// WARN, and revisit once a fortnight of clean baseline exists.
//
// Known limitation, deliberately NOT fixed here: this share is platform-wide,
// so a destination-scoped collapse is diluted by healthy traffic. On 08-18 the
// AU landline rate was 5.4% while the platform rate was 31.9%. A per-
// destination-type split is a separate change.
//
// Both are PURE predicates; the scheduler owns querying, dedupe, and Slack.

export const ANOMALY_WINDOW_MINUTES = 30;
export const ANOMALY_ALERT_DEDUPE_MS = 60 * 60 * 1000; // re-alert hourly while it persists

export const AI_BURST_MIN_VAPI_CALLS = 5;
export const AI_BURST_SHARE_THRESHOLD = 0.5;

export const CONNECT_COLLAPSE_MIN_DIALS = 20;
export const CONNECT_COLLAPSE_RATE_THRESHOLD = 0.5;

export interface AiBurstResult {
  trip: boolean;
  /** Calls that reached Vapi (non-null ended_reason). */
  vapiCount: number;
  errCount: number;
  share: number;
}

export function detectAiPipelineBurst(endedReasons: ReadonlyArray<string | null>): AiBurstResult {
  const vapi = endedReasons.filter((r): r is string => r !== null && r !== undefined);
  const err = vapi.filter((r) => r.startsWith("pipeline-error"));
  const share = vapi.length > 0 ? err.length / vapi.length : 0;
  return {
    trip: vapi.length >= AI_BURST_MIN_VAPI_CALLS && share >= AI_BURST_SHARE_THRESHOLD,
    vapiCount: vapi.length,
    errCount: err.length,
    share,
  };
}

export interface ConnectCollapseResult {
  trip: boolean;
  dials: number;
  connected: number;
  rate: number;
}

export function detectConnectCollapse(
  rows: ReadonlyArray<{ hangup_cause: string | null; duration_seconds: number | null }>,
): ConnectCollapseResult {
  const dials = rows.length;
  const connected = rows.filter(
    (r) => r.hangup_cause === "NORMAL_CLEARING" && (r.duration_seconds ?? 0) > 0,
  ).length;
  const rate = dials > 0 ? connected / dials : 1;
  return {
    trip: dials >= CONNECT_COLLAPSE_MIN_DIALS && rate < CONNECT_COLLAPSE_RATE_THRESHOLD,
    dials,
    connected,
    rate,
  };
}
