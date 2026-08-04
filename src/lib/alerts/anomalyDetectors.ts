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
// no healthy day approaches (baseline ~82%). Catches trunk/CID degradation
// spread across campaigns that never hits the per-campaign 15-straight
// reject breaker (rejectBreaker.ts).
//
// Both are PURE predicates; the scheduler owns querying, dedupe, and Slack.

export const ANOMALY_WINDOW_MINUTES = 30;
export const ANOMALY_ALERT_DEDUPE_MS = 60 * 60 * 1000; // re-alert hourly while it persists

export const AI_BURST_MIN_VAPI_CALLS = 5;
export const AI_BURST_SHARE_THRESHOLD = 0.5;

export const CONNECT_COLLAPSE_MIN_DIALS = 20;
export const CONNECT_COLLAPSE_RATE_THRESHOLD = 0.2;

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
