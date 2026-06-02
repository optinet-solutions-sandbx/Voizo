import { describe, it, expect } from "vitest";
import { safeDiv, median, percentile, parseCountryToken, daysBetween } from "./campaignAnalytics";

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
