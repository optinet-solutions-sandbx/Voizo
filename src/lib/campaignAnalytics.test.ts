import { describe, it, expect } from "vitest";
import { safeDiv, median, percentile, parseCountryToken, daysBetween, computeCampaignAnalytics } from "./campaignAnalytics";
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
