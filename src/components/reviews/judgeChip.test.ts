import { describe, it, expect } from "vitest";
import { judgeChipStyle, formatConfidence } from "./judgeChip";

describe("judgeChipStyle", () => {
  it("maps success/failure/unsure to distinct labels", () => {
    expect(judgeChipStyle("success").label).toBe("success");
    expect(judgeChipStyle("failure").label).toBe("failure");
    expect(judgeChipStyle("unsure").label).toBe("unsure");
  });
  it("falls back to 'not graded' for null/unknown", () => {
    expect(judgeChipStyle(null).label).toBe("not graded");
    expect(judgeChipStyle(undefined).label).toBe("not graded");
    expect(judgeChipStyle("weird").label).toBe("not graded");
  });
  it("known verdicts carry non-empty colour classes", () => {
    for (const v of ["success", "failure", "unsure"]) {
      expect(judgeChipStyle(v).classes.length).toBeGreaterThan(0);
    }
  });
});

describe("formatConfidence", () => {
  it("formats a fraction as a percent", () => {
    expect(formatConfidence(0.87)).toBe("87%");
    expect(formatConfidence(1)).toBe("100%");
    expect(formatConfidence(0)).toBe("0%");
  });
  it("clamps out-of-range and returns '' for null/NaN", () => {
    expect(formatConfidence(1.5)).toBe("100%");
    expect(formatConfidence(null)).toBe("");
    expect(formatConfidence(undefined)).toBe("");
    expect(formatConfidence(NaN)).toBe("");
  });
});
