import { describe, it, expect } from "vitest";
import { ANALYTICS_CONFIG, CONFIG_RATE_PER_MIN } from "./analyticsConfig";

describe("analyticsConfig", () => {
  it("exposes the documented assumption constants", () => {
    expect(ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN).toBe(10);
    expect(ANALYTICS_CONFIG.SAMPLE_FLOOR_FULL).toBe(30);
    expect(ANALYTICS_CONFIG.VOLUME_FLOOR_TARGETED).toBe(50);
    expect(ANALYTICS_CONFIG.VOLUME_FLOOR_DIALED).toBe(20);
    expect(ANALYTICS_CONFIG.GOAL_TRUST_GREEN).toBe(0.95);
    expect(ANALYTICS_CONFIG.GOAL_TRUST_AMBER).toBe(0.8);
    expect(ANALYTICS_CONFIG.SPARKLINE_DAYS).toBe(14);
    expect(ANALYTICS_CONFIG.RECENT_CALL_WINDOW_DAYS).toBe(7);
    expect(ANALYTICS_CONFIG.BENCHMARK_BAND_WIDTH).toBeGreaterThan(0);
  });
  it("combines telephony + AI rates into CONFIG_RATE_PER_MIN", () => {
    expect(CONFIG_RATE_PER_MIN).toBeCloseTo(
      ANALYTICS_CONFIG.CONFIG_RATE_TELEPHONY_PER_MIN + ANALYTICS_CONFIG.CONFIG_RATE_AI_PER_MIN,
    );
  });
});
