import { describe, it, expect } from "vitest";
import { rangeToWindow, MS_PER_DAY } from "./rangeWindow";

const NOW = Date.parse("2026-07-08T12:00:00.000Z");

describe("rangeToWindow", () => {
  it("maps a preset to the last N days ending now", () => {
    expect(rangeToWindow("7d", NOW)).toEqual({ startMs: NOW - 7 * MS_PER_DAY, endMs: NOW });
    expect(rangeToWindow("90d", NOW)).toEqual({ startMs: NOW - 90 * MS_PER_DAY, endMs: NOW });
  });

  it("falls back to 30 days for an unknown range", () => {
    expect(rangeToWindow("bogus", NOW)).toEqual({ startMs: NOW - 30 * MS_PER_DAY, endMs: NOW });
  });

  it("treats lifetime as epoch → now", () => {
    expect(rangeToWindow("lifetime", NOW)).toEqual({ startMs: 0, endMs: NOW });
  });

  it("uses a valid custom from/to (to inclusive to end-of-day)", () => {
    const w = rangeToWindow("custom", NOW, "2026-06-01", "2026-06-10");
    expect(w.startMs).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
    expect(w.endMs).toBe(Date.parse("2026-06-10T00:00:00.000Z") + MS_PER_DAY - 1);
  });

  it("is order-agnostic and never lets a custom window run past now", () => {
    const reversed = rangeToWindow("custom", NOW, "2026-06-10", "2026-06-01");
    expect(reversed.startMs).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
    // a future `to` clamps to now
    expect(rangeToWindow("custom", NOW, "2026-06-01", "2027-01-01").endMs).toBe(NOW);
  });

  it("ignores unparseable custom dates and falls back to the preset", () => {
    expect(rangeToWindow("30d", NOW, "not-a-date", "also-bad")).toEqual({
      startMs: NOW - 30 * MS_PER_DAY,
      endMs: NOW,
    });
  });
});
