/**
 * Editable assumptions for the Campaigns Analytics view (spec §9).
 * These are ASSUMPTIONS, not data. Every $ derived from CONFIG_RATE_* is a
 * labeled "est." proxy. Confidence/volume floors gate trust, not truth.
 * Single visible place to tune — do not scatter these literals.
 */
export const ANALYTICS_CONFIG = {
  // Proxy money rates (PLACEHOLDERS until real rates supplied — spec §16 A4).
  // Split per spec §9 (telephony leg = SquareTalk/FreeSWITCH, AI leg = Vapi).
  CONFIG_RATE_TELEPHONY_PER_MIN: 0.02,
  CONFIG_RATE_AI_PER_MIN: 0.1,

  // Conditional-color neutral band around the portfolio median (fraction).
  BENCHMARK_BAND_WIDTH: 0.1,

  // Confidence gating thresholds (n = connected calls).
  SAMPLE_FLOOR_THIN: 10, // < this => "thin": desaturated, no benchmark color, excluded from median
  SAMPLE_FLOOR_FULL: 30, // >= this => full strength

  // Rollup / leaderboard inclusion floors.
  VOLUME_FLOOR_TARGETED: 50,
  VOLUME_FLOOR_DIALED: 20,

  // Display/explanation only.
  RECENT_CALL_WINDOW_DAYS: 7,

  // Goal-trust badge cutoffs (coverage = connected with goal_reached not null / connected).
  GOAL_TRUST_GREEN: 0.95,
  GOAL_TRUST_AMBER: 0.8,

  // Real sparkline window.
  SPARKLINE_DAYS: 14,

  // Histogram band edges (seconds) for the connected-call duration distribution.
  // Buckets: [0,15) [15,30) [30,60) [60,120) [120,300) [300, ∞). Top bucket is open-ended.
  DURATION_BUCKETS_SEC: [0, 15, 30, 60, 120, 300],

  // Connected-calls outcome breakdown (proxy): a reached human call shorter than this,
  // with no goal and no explicit decline, is treated as an "early hangup" (hung up before
  // intent could be established). Tunable estimate — see computeOne's outcomeBreakdown.
  EARLY_HANGUP_SEC: 15,
} as const;

/** Combined per-minute proxy rate (telephony + AI). Labeled "est." everywhere it surfaces. */
export const CONFIG_RATE_PER_MIN =
  ANALYTICS_CONFIG.CONFIG_RATE_TELEPHONY_PER_MIN + ANALYTICS_CONFIG.CONFIG_RATE_AI_PER_MIN;
