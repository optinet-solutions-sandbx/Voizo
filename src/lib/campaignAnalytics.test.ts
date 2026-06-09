import { describe, it, expect } from "vitest";
import { safeDiv, median, percentile, parseCountryToken, daysBetween, computeCampaignAnalytics, computePortfolio } from "./campaignAnalytics";
import type { AnalyticsInput } from "./campaignAnalytics";
import { FIXTURE_INPUT } from "./campaignAnalytics.fixtures";

describe("safeDiv (G1: no NaN/Infinity)", () => {
  it("returns the ratio for a positive denominator", () => {
    expect(safeDiv(3, 12)).toBeCloseTo(0.25);
  });
  it("returns null when the denominator is 0", () => {
    expect(safeDiv(5, 0)).toBeNull();
  });
  it("returns null when the denominator is negative or non-finite", () => {
    expect(safeDiv(5, -1)).toBeNull();
    expect(safeDiv(5, NaN)).toBeNull();
  });
});

describe("median / percentile", () => {
  it("median of empty is null", () => {
    expect(median([])).toBeNull();
  });
  it("median of odd-length set", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("median of even-length set averages the middle two", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("p95 of empty is null", () => {
    expect(percentile([], 95)).toBeNull();
  });
  it("p95 picks the nearest-rank high value", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    expect(percentile(xs, 95)).toBe(95);
  });
});

describe("parseCountryToken (spec section 2/8 — name token, never timezone)", () => {
  it("parses L7_AU_ -> AU", () => {
    expect(parseCountryToken("L7_AU_Melbourne_Q2")).toBe("AU");
  });
  it("parses L7_CA_ -> CA", () => {
    expect(parseCountryToken("L7_CA_Toronto")).toBe("CA");
  });
  it("falls back to UNKNOWN when no token present", () => {
    expect(parseCountryToken("Random Campaign")).toBe("UNKNOWN");
    expect(parseCountryToken("")).toBe("UNKNOWN");
  });
});

describe("daysBetween", () => {
  it("counts whole days, floored, never negative", () => {
    expect(daysBetween("2026-06-01T00:00:00Z", "2026-06-04T00:00:00Z")).toBe(3);
    expect(daysBetween("2026-06-04T00:00:00Z", "2026-06-01T00:00:00Z")).toBe(0);
  });
});

describe("computeCampaignAnalytics — funnel core (G1/G2/G7)", () => {
  const r = computeCampaignAnalytics(FIXTURE_INPUT);

  it("computes targeted / totalCalls / connected (CONNECTED set, dead buckets ignored)", () => {
    expect(r["big"].targeted).toBe(4);
    expect(r["big"].totalCalls).toBe(6);
    expect(r["big"].connected).toBe(4);
  });
  it("goalCalls counts goal_reached===true only (G2); goalNumbers is distinct", () => {
    expect(r["big"].goalCalls).toBe(2);
    expect(r["big"].goalNumbers).toBe(2);
  });
  it("Conversion = goalCalls/connected, Yield = goalNumbers/targeted", () => {
    expect(r["big"].conversion).toBeCloseTo(0.5);
    expect(r["big"].yield).toBeCloseTo(0.5);
  });
  it("ConnectRate excludes in-flight, divides by terminal set", () => {
    expect(r["big"].connectRate).toBeCloseTo(4 / 6);
  });
  it("reachability = distinct connected numbers / distinct dialed numbers", () => {
    expect(r["big"].dialedNumbers).toBe(4);
    expect(r["big"].connectedNumbers).toBe(3);
    expect(r["big"].reachability).toBeCloseTo(0.75);
  });
  it("country parsed from name token; scheduleType from campaign_type", () => {
    expect(r["big"].country).toBe("AU");
    expect(r["thin"].country).toBe("CA");
    expect(r["big"].scheduleType).toBe("fixed");
  });
  it("G1: a campaign with 0 connected yields null rates, not NaN", () => {
    const empty = computeCampaignAnalytics({
      campaigns: [{ id: "z", name: "Z", is_test: false, created_at: "2026-06-01T00:00:00Z" }],
      numbers: [{ id: "nz", campaign_id: "z", outcome: "pending" }],
      calls: [],
      sms: [],
      now: FIXTURE_INPUT.now,
    });
    expect(empty["z"].conversion).toBeNull();
    expect(empty["z"].connectRate).toBeNull();
    expect(empty["z"].reachability).toBeNull();
  });
});

describe("computeCampaignAnalytics — dispositions (G2/G7)", () => {
  const r = computeCampaignAnalytics(FIXTURE_INPUT);

  it("failureMix counts each terminal non-connect status (big: no_answer 1, failed 1)", () => {
    expect(r["big"].failureMix).toEqual({ no_answer: 1, busy: 0, failed: 1, canceled: 0 });
    expect(r["big"].nonConnectTotal).toBe(2);
  });
  it("exhaustionRate = unreached numbers / targeted (big: n4 unreached => 1/4)", () => {
    expect(r["big"].exhaustionRate).toBeCloseTo(0.25);
  });
  it("activeDeclineRate over engaged leads (big: not_interested 1 of {sent_sms 2, not_interested 1} => 1/3)", () => {
    expect(r["big"].activeDeclineRate).toBeCloseTo(1 / 3);
  });
  it("neverDialedShare: numbers with NO call AND outcome pending/pending_retry (dedicated input)", () => {
    const nd = computeCampaignAnalytics({
      campaigns: [{ id: "nd", name: "ND", created_at: "2026-06-01T00:00:00Z" }],
      numbers: [
        { id: "a", campaign_id: "nd", outcome: "pending" }, // never dialed
        { id: "b", campaign_id: "nd", outcome: "pending_retry" }, // never dialed
        { id: "c", campaign_id: "nd", outcome: "sent_sms" }, // dialed (has a call)
      ],
      calls: [{ campaign_id: "nd", campaign_number_id: "c", status: "completed", goal_reached: true }],
      sms: [],
      now: FIXTURE_INPUT.now,
    });
    expect(nd["nd"].neverDialedShare).toBeCloseTo(2 / 3); // a,b never dialed of 3 targeted
  });
  it("preDialLeakage shares are 0 when no hygiene outcomes present (G7 note: often dead)", () => {
    expect(r["big"].preDialLeakage).toEqual({ suppressed: 0, removed_from_segment: 0, recently_called_elsewhere: 0 });
  });
  it("G1: activeDeclineRate null when no engaged leads", () => {
    const none = computeCampaignAnalytics({
      campaigns: [{ id: "z", name: "Z", created_at: "2026-06-01T00:00:00Z" }],
      numbers: [{ id: "nz", campaign_id: "z", outcome: "pending" }],
      calls: [], sms: [], now: FIXTURE_INPUT.now,
    });
    expect(none["z"].activeDeclineRate).toBeNull();
  });
});

describe("computeCampaignAnalytics — duration/density/retry/velocity/sparkline/sms (G1/G2)", () => {
  const r = computeCampaignAnalytics(FIXTURE_INPUT);

  it("duration median/p95 over completed non-null only (big durations: 120,30,90,200)", () => {
    // sorted: 30,90,120,200 => median (90+120)/2 = 105
    expect(r["big"].durationMedian).toBe(105);
    expect(r["big"].durationP95).toBe(200);
    expect(r["big"].talkSeconds).toBe(440);
    expect(r["big"].talkSecondsOnGoal).toBe(210); // 120 + 90
  });
  it("goalDensityPerMin = goalCalls / (talkSeconds/60) (big: 2 / (440/60))", () => {
    expect(r["big"].goalDensityPerMin).toBeCloseTo(2 / (440 / 60));
  });
  it("retryPayoff: per-number attempt index by created_at, connect rate at attempt N", () => {
    // attempt1: dialed {n1,n2,n3,n4}=4, connected {n1,n2}=2 => 0.5
    // attempt2: dialed {n1,n3}=2, connected {n1,n3}=2 => 1.0
    const p1 = r["big"].retryPayoff.find((p) => p.attempt === 1)!;
    const p2 = r["big"].retryPayoff.find((p) => p.attempt === 2)!;
    expect(p1.dialed).toBe(4);
    expect(p1.connected).toBe(2);
    expect(p1.connectRate).toBeCloseTo(0.5);
    expect(p2.dialed).toBe(2);
    expect(p2.connected).toBe(2);
    expect(p2.connectRate).toBeCloseTo(1);
  });
  it("goalVelocity = goalCalls / activeDays (big start 05-19, now 06-02 12:00 => 14 days)", () => {
    expect(r["big"].activeDays).toBe(14);
    expect(r["big"].goalVelocity).toBeCloseTo(2 / 14);
  });
  it("sparkline has SPARKLINE_DAYS points, zero-filled, oldest->newest, goals bucketed by UTC date", () => {
    expect(r["big"].sparkline).toHaveLength(14);
    const last = r["big"].sparkline[r["big"].sparkline.length - 1];
    expect(last.date).toBe("2026-06-02");
    const may30 = r["big"].sparkline.find((p) => p.date === "2026-05-30")!;
    expect(may30.goals).toBe(2); // n1 + n2 goal calls on 05-30
  });
  it("sms delivered/failed/inFlight + provider breakdown (big: delivered1, failed=failed+undelivered=2, inFlight=1)", () => {
    expect(r["big"].sms.delivered).toBe(1);
    expect(r["big"].sms.failed).toBe(2);
    expect(r["big"].sms.inFlight).toBe(1);
    expect(r["big"].sms.byProvider["mobivate"]).toEqual({ delivered: 1, failed: 2, inFlight: 1 });
  });
});

describe("computeCampaignAnalytics — confidence/trust/leak/inclusion (G3/G4/G5)", () => {
  const r = computeCampaignAnalytics(FIXTURE_INPUT);

  it("confidence from n=connected (fixtures intentionally below SAMPLE_FLOOR_THIN => thin)", () => {
    expect(r["big"].confidence).toBe("thin");
    expect(r["thin"].confidence).toBe("thin");
  });
  it("goalTrustCoverage = connected calls with goal_reached !== null / connected", () => {
    // big's 4 connected calls have goal_reached [true, false, true, null] => non-null 3, null 1 => 3/4
    expect(r["big"].goalReachedNullCount).toBe(1);
    expect(r["big"].goalTrustCoverage).toBeCloseTo(0.75);
  });
  it("includedInPortfolio false for is_test (G3) and for below-volume-floor", () => {
    expect(r["test"].includedInPortfolio).toBe(false); // is_test
    expect(r["big"].includedInPortfolio).toBe(false); // targeted 4 < VOLUME_FLOOR_TARGETED 50
  });
  it("biggestLeak is 'none' below volume floor (G3/G4 — no triage on thin data)", () => {
    expect(r["big"].biggestLeak).toBe("none");
  });
});

describe("computePortfolio (G3/G4)", () => {
  it("excludes test + low-volume; medians over included non-thin", () => {
    const r = computeCampaignAnalytics(FIXTURE_INPUT);
    const p = computePortfolio(Object.values(r));
    expect(p.includedCount).toBe(0); // all fixtures below floor
    expect(p.excludedTestCount).toBe(1);
    expect(p.medianConversion).toBeNull(); // nothing included
    expect(p.portfolioConversion).toBeNull();
  });
  it("computes portfolio rates + median over a high-volume synthetic set", () => {
    const synth = makeHighVolumePair();
    const r = computeCampaignAnalytics(synth);
    const p = computePortfolio(Object.values(r));
    expect(p.includedCount).toBe(2);
    expect(p.portfolioConversion).not.toBeNull();
    expect(p.medianConversion).not.toBeNull();
    expect(p.estSpend).toBeGreaterThan(0);
  });

  // Task 8 — GhostPortal segregation. A LIVE ghost run (is_test=false) must NOT
  // leak into portfolio totals OR the goal-trust (nonTest) gate, even at volume.
  it("excludes a high-volume LIVE source=ghost_portal campaign from included + goal-trust", () => {
    const synth = makeHighVolumePair();
    synth.campaigns.push({ id: "G", name: "Ghost", is_test: false, source: "ghost_portal", start_at: "2026-05-01T00:00:00Z", created_at: "2026-05-01T00:00:00Z", campaign_type: "fixed" });
    for (let i = 0; i < 60; i++) synth.numbers.push({ id: `G${i}`, campaign_id: "G", outcome: "pending" });
    for (let i = 0; i < 40; i++) synth.calls.push({ campaign_id: "G", campaign_number_id: `G${i}`, status: "completed", goal_reached: i < 20, duration_seconds: 60, created_at: "2026-05-30T10:00:00Z" });
    const r = computeCampaignAnalytics(synth);
    const p = computePortfolio(Object.values(r));
    expect(r["G"].isGhost).toBe(true);
    expect(r["G"].includedInPortfolio).toBe(false); // excluded despite non-test + volume
    expect(p.includedCount).toBe(2); // only A + B
  });
});

function makeHighVolumePair(): AnalyticsInput {
  const now = Date.parse("2026-06-02T12:00:00Z");
  const campaigns = [
    { id: "A", name: "L7_AU_A", is_test: false, start_at: "2026-05-01T00:00:00Z", created_at: "2026-05-01T00:00:00Z", campaign_type: "fixed" },
    { id: "B", name: "L7_AU_B", is_test: false, start_at: "2026-05-01T00:00:00Z", created_at: "2026-05-01T00:00:00Z", campaign_type: "fixed" },
  ];
  const numbers: AnalyticsInput["numbers"] = [];
  const calls: AnalyticsInput["calls"] = [];
  // A: 60 targeted, 40 connected, 20 goal (conv 0.5)
  for (let i = 0; i < 60; i++) numbers.push({ id: `A${i}`, campaign_id: "A", outcome: "pending" });
  for (let i = 0; i < 40; i++) calls.push({ campaign_id: "A", campaign_number_id: `A${i}`, status: "completed", goal_reached: i < 20, duration_seconds: 60, created_at: "2026-05-30T10:00:00Z" });
  // B: 60 targeted, 40 connected, 10 goal (conv 0.25)
  for (let i = 0; i < 60; i++) numbers.push({ id: `B${i}`, campaign_id: "B", outcome: "pending" });
  for (let i = 0; i < 40; i++) calls.push({ campaign_id: "B", campaign_number_id: `B${i}`, status: "completed", goal_reached: i < 10, duration_seconds: 60, created_at: "2026-05-30T10:00:00Z" });
  return { campaigns, numbers, calls, sms: [], now };
}

describe("computeCampaignAnalytics — durationHistogram + strict funnel (Phase 2)", () => {
  const r = computeCampaignAnalytics(FIXTURE_INPUT);

  it("buckets connected-call durations by DURATION_BUCKETS_SEC (big: [120,30,90,200])", () => {
    const h = r["big"].durationHistogram;
    expect(h).toHaveLength(6); // edges [0,15,30,60,120,300] -> 6 buckets, top open-ended
    const count = (lo: number) => h.find((b) => b.lowerSec === lo)!.count;
    expect(count(0)).toBe(0);
    expect(count(15)).toBe(0);
    expect(count(30)).toBe(1); // 30
    expect(count(60)).toBe(1); // 90
    expect(count(120)).toBe(2); // 120, 200
    expect(count(300)).toBe(0);
    expect(h[h.length - 1].upperSec).toBeNull(); // open-ended top
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(4); // = connected non-null durations
  });

  it("empty-duration campaign yields all-zero buckets (no NaN, no crash)", () => {
    const empty = computeCampaignAnalytics({
      campaigns: [{ id: "z", name: "Z", created_at: "2026-06-01T00:00:00Z" }],
      numbers: [{ id: "nz", campaign_id: "z", outcome: "pending" }],
      calls: [], sms: [], now: FIXTURE_INPUT.now,
    });
    expect(empty["z"].durationHistogram.every((b) => b.count === 0)).toBe(true);
  });

  it("strict nested funnel holds for the waterfall (targeted >= dialed >= connected >= goal)", () => {
    const a = r["big"];
    expect(a.targeted).toBeGreaterThanOrEqual(a.dialedNumbers);
    expect(a.dialedNumbers).toBeGreaterThanOrEqual(a.connectedNumbers);
    expect(a.connectedNumbers).toBeGreaterThanOrEqual(a.goalNumbers);
    expect([a.targeted, a.dialedNumbers, a.connectedNumbers, a.goalNumbers]).toEqual([4, 4, 3, 2]);
  });
});
