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
  it("false when windows empty (VOZ-364: fail closed, never dial on an unconfigured window)", () => {
    expect(isWithinCallWindowAt([], tz, Date.parse("2026-06-02T03:00:00Z"))).toBe(false);
  });
  it("false when windows is null/missing (VOZ-364: same fail-closed treatment as empty)", () => {
    expect(isWithinCallWindowAt(null as unknown as never, tz, Date.parse("2026-06-02T03:00:00Z"))).toBe(false);
  });
  // VOZ-364 / f174e9a class: an invalid-but-truthy tz makes Intl throw RangeError.
  // Uncaught it 500s the whole scheduler tick every minute (the outage f174e9a fixed
  // in the sibling trunk gate). Must DENY and must NOT throw — assert both, because
  // `.toBe(false)` alone would also "pass" a throw if the throw were what we wanted.
  const badTimezones = ["Manila", "", "Australia/Sydneyy", "UTC+10", "not a tz"];
  for (const badTz of badTimezones) {
    it(`false and NO THROW on unusable timezone ${JSON.stringify(badTz)} (one bad row must not take the fleet down)`, () => {
      const call = () => isWithinCallWindowAt(tue, badTz, Date.parse("2026-06-02T22:30:00Z"));
      expect(call).not.toThrow();
      expect(call()).toBe(false);
    });
  }
  // Boundary locks — Option A's no-false-block on aligned campaigns rides on the
  // OPEN edge being inclusive and the CLOSE edge exclusive (matches dialer's < end).
  it("true at the OPEN edge (start == window.start) — aligned campaigns never false-block", () =>
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-02T22:00:00Z"))).toBe(true)); // Tue 18:00
  it("false at the CLOSE edge (start == window.end) — matches the cron's `< end`", () =>
    expect(isWithinCallWindowAt(tue, tz, Date.parse("2026-06-03T01:00:00Z"))).toBe(false)); // Tue 21:00

  // ── VOZ-360 regression locks: MULTIPLE windows on one day ──────────────────
  // The old `.find()` honoured only the FIRST window per day, so the afternoon band
  // of a split window never dialled. 2026-06-01 is a Monday; Toronto in June = EDT (UTC-4).
  const split = [
    { day: "mon", start: "09:00", end: "10:00" },
    { day: "mon", start: "15:00", end: "19:00" },
  ];
  it("true inside the FIRST of two same-day windows", () =>
    expect(isWithinCallWindowAt(split, tz, Date.parse("2026-06-01T13:30:00Z"))).toBe(true)); // Mon 09:30
  it("true inside the SECOND of two same-day windows (old .find() returned false)", () =>
    expect(isWithinCallWindowAt(split, tz, Date.parse("2026-06-01T20:00:00Z"))).toBe(true)); // Mon 16:00
  it("false in the GAP between two same-day windows", () =>
    expect(isWithinCallWindowAt(split, tz, Date.parse("2026-06-01T16:00:00Z"))).toBe(false)); // Mon 12:00
  it("false after the LAST of two same-day windows closes", () =>
    expect(isWithinCallWindowAt(split, tz, Date.parse("2026-06-01T23:30:00Z"))).toBe(false)); // Mon 19:30

  // ── VOZ-365 regression lock: integer compare, not lexical ─────────────────
  // Lexically "18:30" >= "9:00" is FALSE ("1" < "9"), so an unpadded start silently
  // closed the window after 09:59. Nothing validates zero-padding on write.
  it("true with an UNPADDED start time (lexical compare said false)", () =>
    expect(
      isWithinCallWindowAt([{ day: "tue", start: "9:00", end: "20:00" }], tz, Date.parse("2026-06-02T22:30:00Z")),
    ).toBe(true)); // Tue 18:30

  // ── midnight edge: the dialer used to lack the "24" normalization entirely ──
  it("true at exactly 00:00 for a midnight-opening window", () =>
    expect(
      isWithinCallWindowAt([{ day: "tue", start: "00:00", end: "08:00" }], tz, Date.parse("2026-06-02T04:00:00Z")),
    ).toBe(true)); // Tue 00:00 Toronto

  // ── malformed windows must never match, rather than match unpredictably ────
  const inverted = [{ day: "tue", start: "21:00", end: "18:00" }]; // start >= end
  it("false for an inverted window, before its start", () =>
    expect(isWithinCallWindowAt(inverted, tz, Date.parse("2026-06-02T23:00:00Z"))).toBe(false)); // Tue 19:00
  it("false for an inverted window, after its start (never matches)", () =>
    expect(isWithinCallWindowAt(inverted, tz, Date.parse("2026-06-03T02:00:00Z"))).toBe(false)); // Tue 22:00
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
