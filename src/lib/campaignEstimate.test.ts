import { describe, expect, it } from "vitest";
import {
  estimateCampaign,
  expectedAttempts,
  type BehaviorRates,
  type EstimateInput,
} from "./campaignEstimate";
import type { PriceRates } from "./costRates";

describe("expectedAttempts — truncated geometric E[dials | k tries left]", () => {
  it("p=1: everyone resolves on the first try", () => {
    expect(expectedAttempts(3, 1)).toBe(1);
  });
  it("p=0: nothing resolves early — worst case = all k tries", () => {
    expect(expectedAttempts(3, 0)).toBe(3);
  });
  it("p=0.5, k=3: (1 - 0.5^3) / 0.5 = 1.75", () => {
    expect(expectedAttempts(3, 0.5)).toBeCloseTo(1.75, 10);
  });
  it("k=1 is always exactly 1 dial regardless of p", () => {
    expect(expectedAttempts(1, 0.2)).toBe(1);
    expect(expectedAttempts(1, 0.9)).toBe(1);
  });
  it("k=0 or negative: no tries left, no dials", () => {
    expect(expectedAttempts(0, 0.5)).toBe(0);
    expect(expectedAttempts(-2, 0.5)).toBe(0);
  });
  it("out-of-range p clamps to the sane branch (p>1 behaves as 1)", () => {
    expect(expectedAttempts(3, 1.5)).toBe(1);
  });
});

const behavior: BehaviorRates = {
  p: 0.5, rConnect: 0.6, tTalkSec: 50,
  tTalkHumanSec: 80, tTalkVoicemailSec: 12, voicemailShare: 0.4,
  dialsPerHourP25: 40, dialsPerHourP50: 60, dialsPerHourP75: 80,
  provenance: {
    windowFrom: "2026-07-28", windowTo: "2026-08-03", excludedDays: ["2026-08-02", "2026-08-03"],
    level: "country", levelSamples: { country: 5000 },
    sampleDials: 5000, samplePlayers: 2600, computedAt: "2026-08-04T00:00:00Z",
  },
};
const prices: PriceRates = {
  vapiPerTalkMin: 0.05, openaiPerTalkMin: 0.032,
  verified: { vapi: false, openai: false }, basis: "test",
};
const fixedInput = (over: Partial<EstimateInput> = {}): EstimateInput => ({
  remainingTries: { 3: 2000 }, retryGapMinutes: 90, windowHoursPerDay: 10,
  enabledDaysPerWeek: 5, realtime: false, dailyCap: null, ...over,
});

describe("estimateCampaign — dials", () => {
  it("uniform histogram {3:2000}, p=0.5 → 2000×1.75 = 3500 expected; bounds 2000..6000", () => {
    const e = estimateCampaign(fixedInput(), behavior, prices);
    expect(e.totalPlayers).toBe(2000);
    expect(e.expectedDials.value).toBeCloseTo(3500, 6);
    expect(e.expectedDials.min).toBe(2000);
    expect(e.expectedDials.max).toBe(6000);
  });
  it("mixed histogram = sum of its buckets", () => {
    const mixed = estimateCampaign(fixedInput({ remainingTries: { 1: 100, 3: 200 } }), behavior, prices);
    // 100×1 + 200×1.75 = 450
    expect(mixed.expectedDials.value).toBeCloseTo(450, 6);
    expect(mixed.expectedDials.min).toBe(300);
    expect(mixed.expectedDials.max).toBe(100 + 600);
  });
  it("zero-tries and zero-count buckets are ignored", () => {
    const e = estimateCampaign(fixedInput({ remainingTries: { 0: 500, 3: 0, 2: 10 } }), behavior, prices);
    expect(e.totalPlayers).toBe(10);
  });
});

describe("estimateCampaign — talk minutes and cost", () => {
  it("talk = dials × rConnect × tTalkSec/60; costs multiply; total = vapi+openai", () => {
    const e = estimateCampaign(fixedInput(), behavior, prices);
    const expectedTalk = 3500 * 0.6 * 50 / 60; // 1750
    expect(e.talkMinutes.value).toBeCloseTo(expectedTalk, 6);
    expect(e.costVapi.value).toBeCloseTo(expectedTalk * 0.05, 6);
    expect(e.costOpenai.value).toBeCloseTo(expectedTalk * 0.032, 6);
    expect(e.costTotal.value).toBeCloseTo(e.costVapi.value + e.costOpenai.value, 10);
  });
  it("bounds stay ordered min <= value <= max on every line", () => {
    const e = estimateCampaign(fixedInput(), behavior, prices);
    for (const line of [e.expectedDials, e.talkMinutes, e.costVapi, e.costOpenai, e.costTotal]) {
      expect(line.min).toBeLessThanOrEqual(line.value);
      expect(line.value).toBeLessThanOrEqual(line.max);
    }
  });
});

describe("estimateCampaign — duration", () => {
  it("fixed: mid = dials/(p50×hours) × 7/enabledDays; bounds ordered", () => {
    const e = estimateCampaign(fixedInput(), behavior, prices);
    // 3500 / (60×10) × 7/5 = 8.1666...
    expect(e.durationDays).not.toBeNull();
    expect(e.durationDays!.value).toBeCloseTo((3500 / 600) * (7 / 5), 6);
    expect(e.durationDays!.min).toBeLessThanOrEqual(e.durationDays!.value);
    expect(e.durationDays!.value).toBeLessThanOrEqual(e.durationDays!.max);
  });
  it("retry gap spanning the whole window floors the pessimistic bound at maxTries days-equivalent", () => {
    const e = estimateCampaign(fixedInput({ retryGapMinutes: 700, windowHoursPerDay: 10 }), behavior, prices);
    expect(e.durationDays!.max).toBeGreaterThanOrEqual(3 * (7 / 5));
  });
  it("no enabled windows → duration null + loud warning", () => {
    const e = estimateCampaign(fixedInput({ windowHoursPerDay: 0, enabledDaysPerWeek: 0 }), behavior, prices);
    expect(e.durationDays).toBeNull();
    expect(e.warnings.some((w) => w.includes("window"))).toBe(true);
  });
  it("realtime with known audience: duration = ceil(players/dailyCap) exact; over-capacity cap warns", () => {
    const e = estimateCampaign(
      fixedInput({ realtime: true, dailyCap: 1000, remainingTries: { 3: 1000 } }),
      behavior, prices,
    );
    expect(e.durationDays).not.toBeNull();
    expect(e.durationDays!.value).toBe(1); // ceil(1000/1000)
    expect(e.durationDays!.min).toBe(1);
    expect(e.durationDays!.max).toBe(1);
    expect(e.warnings.some((w) => w.includes("cap"))).toBe(true); // 1000 > 60×10
  });
  it("realtime 2043 players at cap 500 → 5 admission days (the CIO-segment case)", () => {
    const e = estimateCampaign(
      fixedInput({ realtime: true, dailyCap: 500, remainingTries: { 3: 2043 }, windowHoursPerDay: 10 }),
      behavior, prices,
    );
    expect(e.durationDays!.value).toBe(5); // ceil(2043/500)
    expect(e.warnings.some((w) => w.includes("cap"))).toBe(false); // 500 < 60×10
  });
  it("realtime without a cap or without players: duration null", () => {
    const noCap = estimateCampaign(
      fixedInput({ realtime: true, dailyCap: null, remainingTries: { 3: 2043 } }),
      behavior, prices,
    );
    expect(noCap.durationDays).toBeNull();
    const noPlayers = estimateCampaign(
      fixedInput({ realtime: true, dailyCap: 500, remainingTries: {} }),
      behavior, prices,
    );
    expect(noPlayers.durationDays).toBeNull();
  });
});

describe("estimateCampaign — degenerate inputs never NaN", () => {
  it("empty histogram → all-zero lines, no NaN anywhere", () => {
    const e = estimateCampaign(fixedInput({ remainingTries: {} }), behavior, prices);
    expect(e.totalPlayers).toBe(0);
    for (const line of [e.expectedDials, e.talkMinutes, e.costTotal]) {
      expect(Number.isNaN(line.value)).toBe(false);
      expect(line.value).toBe(0);
    }
  });
});
