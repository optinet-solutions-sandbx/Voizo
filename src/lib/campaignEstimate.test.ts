import { describe, expect, it } from "vitest";
import { expectedAttempts } from "./campaignEstimate";

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
