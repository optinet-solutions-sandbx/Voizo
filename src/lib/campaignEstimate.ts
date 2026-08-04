// src/lib/campaignEstimate.ts
//
// PURE estimation engine for the campaign cost estimator (spec 2026-08-04 §4).
// No I/O — both the wizard PreviewRail and the campaign detail page call
// estimateCampaign() with rates fetched from /api/campaigns-v2/estimate-rates.
// THE ONE CLOCK: every minute here is a duration_seconds (billsec) minute.

import type { PriceRates } from "./costRates";

export interface EstimateInput {
  /** triesLeft -> playerCount. Wizard: { [maxTries]: players }. Detail page: histogram. */
  remainingTries: Record<number, number>;
  retryGapMinutes: number;
  /** Average enabled call-window length, hours. 0 = no windows enabled. */
  windowHoursPerDay: number;
  enabledDaysPerWeek: number;
  realtime: boolean;
  dailyCap: number | null;
}

export interface RatesProvenance {
  windowFrom: string | null;
  windowTo: string | null;
  excludedDays: string[];
  level: "lineage" | "country" | "global";
  levelSamples: Partial<Record<"lineage" | "country" | "global", number>>;
  sampleDials: number;
  samplePlayers: number;
  computedAt: string;
}

export interface BehaviorRates {
  /** Per-attempt resolution probability = terminal players ÷ dials. */
  p: number;
  /** Connected dials ÷ all dials (connected = NORMAL_CLEARING & duration>0). */
  rConnect: number;
  /** Avg duration_seconds over connected calls (blended human+voicemail). */
  tTalkSec: number;
  tTalkHumanSec: number | null;
  tTalkVoicemailSec: number | null;
  voicemailShare: number | null;
  /** Dials per campaign-hour percentiles over healthy campaign-days. */
  dialsPerHourP25: number;
  dialsPerHourP50: number;
  dialsPerHourP75: number;
  provenance: RatesProvenance;
}

export interface EstimateLine {
  value: number;
  min: number;
  max: number;
  /** Human-readable derivation, rendered verbatim in the audit panel. */
  formula: string;
}

export interface CampaignEstimate {
  totalPlayers: number;
  expectedDials: EstimateLine;
  talkMinutes: EstimateLine;
  costVapi: EstimateLine;
  costOpenai: EstimateLine;
  costTotal: EstimateLine;
  /** null when it cannot be computed (realtime, or no windows/throughput). */
  durationDays: EstimateLine | null;
  warnings: string[];
}

/**
 * E[dials | k tries left] under a truncated geometric: each attempt resolves
 * the player with probability p (assumption disclosed in the audit panel).
 * p<=0 degrades to the exact worst case (k); p>=1 to the exact best case (1).
 */
export function expectedAttempts(triesLeft: number, p: number): number {
  if (triesLeft <= 0) return 0;
  if (p >= 1) return 1;
  if (p <= 0) return triesLeft;
  // k=1 is exactly 1 dial by definition — skip the FP round-trip, which
  // yields 0.9999999999999998 for e.g. p=0.2 and breaks exact invariants.
  if (triesLeft === 1) return 1;
  return (1 - Math.pow(1 - p, triesLeft)) / p;
}
