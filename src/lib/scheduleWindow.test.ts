import { describe, it, expect } from "vitest";
import {
  clockHHMMInTimezone,
  isWithinCallWindowAt,
  resolveStartAt,
  minWindowMinutes,
  retryFitsShortestWindow,
  shouldStayAwakeRealtime,
} from "./scheduleWindow";

describe("isWithinCallWindowAt", () => {
  const tz = "America/Toronto"; // June = EDT (UTC-4)
  const tue = [{ day: "tue", start: "18:00", end: "21:00" }];
  it("true inside the day's window", () => {
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-02T22:30:00Z"))).toBe(true); // Tue 18:30
  });
  it("false before the window opens", () => {
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-02T20:00:00Z"))).toBe(false); // Tue 16:00
  });
  it("false when no window for today's weekday", () => {
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-03T22:30:00Z"))).toBe(false); // Wed
  });
  it("true when windows empty (always open)", () => {
    expect(isWithinCallWindowAt([], tz, Date.parse("2026-06-02T03:00:00Z"))).toBe(true);
  });
  // Boundary locks — Option A's no-false-block on aligned campaigns rides on the
  // OPEN edge being inclusive and the CLOSE edge exclusive (matches dialer's < end).
  it("true at the OPEN edge (start == window.start) — aligned campaigns never false-block", () =>
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-02T22:00:00Z"))).toBe(true)); // Tue 18:00
  it("false at the CLOSE edge (start == window.end) — matches the cron's `< end`", () =>
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-03T01:00:00Z"))).toBe(false)); // Tue 21:00
});

describe("resolveStartAt", () => {
  const now = Date.parse("2026-06-03T07:00:00Z");
  it("now → nowMs ISO", () => expect(resolveStartAt("now", 60, "", now)).toBe(new Date(now).toISOString()));
  it("delay → now + minutes", () =>
    expect(resolveStartAt("delay", 30, "", now)).toBe(new Date(now + 30 * 60_000).toISOString()));
  it("scheduled w/ date", () =>
    expect(resolveStartAt("scheduled", 60, "2026-06-04T18:00", now)).toBe(new Date("2026-06-04T18:00").toISOString()));
  it("scheduled w/o date → null", () => expect(resolveStartAt("scheduled", 60, "", now)).toBeNull());
});

describe("clockHHMMInTimezone", () => {
  it("renders HH:MM in the given tz", () =>
    expect(clockHHMMInTimezone(Date.parse("2026-06-02T22:30:00Z"), "America/Toronto")).toBe("18:30")); // EDT -4
  it("renders a different tz from the same instant", () =>
    expect(clockHHMMInTimezone(Date.parse("2026-06-02T22:30:00Z"), "Australia/Sydney")).toBe("08:30")); // AEST +10
  it("normalizes the midnight '24' edge to 00:00", () =>
    expect(clockHHMMInTimezone(Date.parse("2026-06-02T04:00:00Z"), "America/Toronto")).toBe("00:00")); // 00:00 Toronto
});

describe("minWindowMinutes", () => {
  it("null when there are no windows (always open)", () => expect(minWindowMinutes([])).toBeNull());
  it("length of a single window", () =>
    expect(minWindowMinutes([{ day: "tue", start: "20:00", end: "21:00" }])).toBe(60));
  it("the SHORTEST enabled window across rows", () =>
    expect(
      minWindowMinutes([
        { day: "mon", start: "09:00", end: "17:00" },
        { day: "tue", start: "20:00", end: "21:00" },
      ]),
    ).toBe(60));
});

describe("retryFitsShortestWindow", () => {
  it("fits when there are no windows (always open)", () => expect(retryFitsShortestWindow([], 90)).toBe(true));
  it("does NOT fit when the shortest window is shorter than the retry gap", () =>
    expect(retryFitsShortestWindow([{ day: "tue", start: "20:00", end: "21:00" }], 90)).toBe(false)); // 60 < 90
  it("does NOT fit at the boundary (window == retry — retry lands on the close edge)", () =>
    expect(retryFitsShortestWindow([{ day: "tue", start: "19:30", end: "21:00" }], 90)).toBe(false)); // 90 !> 90
  it("fits when the shortest window is longer than the retry gap", () =>
    expect(retryFitsShortestWindow([{ day: "mon", start: "09:00", end: "17:00" }], 90)).toBe(true)); // 480 > 90
});

describe("shouldStayAwakeRealtime", () => {
  const now = Date.parse("2026-07-22T08:50:33Z"); // the instant the trial child was wrongly completed
  it("true: realtime child, end_at in the future — stays awake for later signups", () =>
    expect(shouldStayAwakeRealtime({ realtime: true, end_at: "2026-07-22T13:00:00Z" }, now)).toBe(true));
  it("false: realtime child, end_at passed — day is over, completion is correct", () =>
    expect(shouldStayAwakeRealtime({ realtime: true, end_at: "2026-07-22T08:00:00Z" }, now)).toBe(false));
  it("false: exactly AT end_at — strict >, matches the scheduler's inline guard", () =>
    expect(shouldStayAwakeRealtime({ realtime: true, end_at: "2026-07-22T08:50:33Z" }, now)).toBe(false));
  it("false: non-realtime campaign (guarded no-op for every other campaign)", () =>
    expect(shouldStayAwakeRealtime({ realtime: false, end_at: "2026-07-22T13:00:00Z" }, now)).toBe(false));
  it("false: realtime column absent (pre-migration row → falsy)", () =>
    expect(shouldStayAwakeRealtime({ end_at: "2026-07-22T13:00:00Z" }, now)).toBe(false));
  it("false: end_at null — fail-closed to today's completion behavior", () =>
    expect(shouldStayAwakeRealtime({ realtime: true, end_at: null }, now)).toBe(false));
  it("false: end_at malformed — Invalid Date compares false, fail-closed", () =>
    expect(shouldStayAwakeRealtime({ realtime: true, end_at: "not-a-date" }, now)).toBe(false));
});
