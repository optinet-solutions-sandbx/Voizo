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

function scaleLine(line: EstimateLine, factor: number, formula: string): EstimateLine {
  return { value: line.value * factor, min: line.min * factor, max: line.max * factor, formula };
}

export function estimateCampaign(
  input: EstimateInput,
  behavior: BehaviorRates,
  prices: PriceRates,
): CampaignEstimate {
  const warnings: string[] = [];

  const buckets = Object.entries(input.remainingTries)
    .map(([k, n]) => ({ k: Number(k), n }))
    .filter((b) => Number.isFinite(b.k) && b.k > 0 && Number.isFinite(b.n) && b.n > 0);
  const totalPlayers = buckets.reduce((s, b) => s + b.n, 0);

  const expectedDials: EstimateLine = {
    value: buckets.reduce((s, b) => s + b.n * expectedAttempts(b.k, behavior.p), 0),
    min: totalPlayers, // exact best case: every player resolves on try 1
    max: buckets.reduce((s, b) => s + b.n * b.k, 0), // exact worst case: all tries burned
    formula: `Σ players × (1−(1−p)^triesLeft)/p with p=${behavior.p.toFixed(3)} (assumes constant per-attempt resolution)`,
  };

  const perDialTalkMin = (behavior.rConnect * behavior.tTalkSec) / 60;
  const talkMinutes = scaleLine(
    expectedDials, perDialTalkMin,
    `dials × ${behavior.rConnect.toFixed(3)} connect-rate × ${behavior.tTalkSec.toFixed(1)}s avg talk ÷ 60`,
  );
  const costVapi = scaleLine(talkMinutes, prices.vapiPerTalkMin, `talk-min × $${prices.vapiPerTalkMin}/min (Vapi)`);
  const costOpenai = scaleLine(talkMinutes, prices.openaiPerTalkMin, `talk-min × $${prices.openaiPerTalkMin}/min (OpenAI, blended incl. voicemail)`);
  const costTotal: EstimateLine = {
    value: costVapi.value + costOpenai.value,
    min: costVapi.min + costOpenai.min,
    max: costVapi.max + costOpenai.max,
    formula: "Vapi + OpenAI",
  };

  let durationDays: EstimateLine | null = null;
  if (input.realtime) {
    // Real-time: admission is paced by the daily cap, so with a KNOWN audience
    // (imported segment snapshot) duration is exact pacing math — ceil(P/cap).
    // Continuous inflow can extend it; the formula discloses that. Without a
    // cap or without players the duration is unknowable → null (card falls
    // back to per-day framing when the caller passes cap-as-players).
    if (totalPlayers > 0 && input.dailyCap !== null && input.dailyCap > 0) {
      const days = Math.ceil(totalPlayers / input.dailyCap);
      durationDays = {
        value: days,
        min: days,
        max: days,
        formula:
          `ceil(${totalPlayers.toLocaleString()} players ÷ ${input.dailyCap}/day admission cap) — ` +
          `exact pacing for today's audience; new sign-ups extend it, last-day retries may spill`,
      };
    }
    const capacityMid = behavior.dialsPerHourP50 * input.windowHoursPerDay;
    if (input.dailyCap !== null && capacityMid > 0 && input.dailyCap > capacityMid) {
      warnings.push(
        `Daily cap (${input.dailyCap}) exceeds typical daily dial capacity (~${Math.round(capacityMid)} dials/day) — the cap may not be reached.`,
      );
    }
  } else if (totalPlayers > 0) {
    const capacityMid = behavior.dialsPerHourP50 * input.windowHoursPerDay;
    const capacityBest = behavior.dialsPerHourP75 * input.windowHoursPerDay;
    const capacityWorst = behavior.dialsPerHourP25 * input.windowHoursPerDay;
    if (capacityMid > 0 && input.enabledDaysPerWeek > 0) {
      const calendarFactor = 7 / input.enabledDaysPerWeek;
      let worst = capacityWorst > 0 ? (expectedDials.max / capacityWorst) * calendarFactor : Infinity;
      // Retry-gap floor: a gap spanning the whole daily window means one attempt
      // per player per day — the campaign cannot finish faster than maxTries cycles.
      const maxTries = Math.max(...buckets.map((b) => b.k));
      if (input.retryGapMinutes >= input.windowHoursPerDay * 60) {
        worst = Math.max(worst, maxTries * calendarFactor);
      }
      durationDays = {
        value: (expectedDials.value / capacityMid) * calendarFactor,
        min: capacityBest > 0 ? (expectedDials.min / capacityBest) * calendarFactor : 0,
        max: worst,
        formula:
          `dials ÷ (${behavior.dialsPerHourP50.toFixed(0)} dials/hr × ${input.windowHoursPerDay.toFixed(1)}h window) ` +
          `× 7/${input.enabledDaysPerWeek} enabled days — assumes typical concurrent load`,
      };
    } else {
      warnings.push("No call windows enabled — duration cannot be estimated.");
    }
  }

  return { totalPlayers, expectedDials, talkMinutes, costVapi, costOpenai, costTotal, durationDays, warnings };
}
