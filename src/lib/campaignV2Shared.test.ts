import { describe, it, expect } from "vitest";
import {
  parsePhoneList,
  defaultCallWindows,
  formatDefaultCallWindowsJson,
  normalizeOperatorControls,
  resolveCallDelay,
  CALL_DELAY_MAX_MINUTES,
} from "./campaignV2Shared";

// These tests pin the pure-helper contract that moved out of campaignV2Data.ts
// into the neutral, supabase-free campaignV2Shared module (RLS Phase A). The
// extraction must preserve behaviour byte-for-byte — client components value-
// import these and must NOT drag the server-only admin client into the bundle.

describe("parsePhoneList", () => {
  it("normalizes a single E.164 number unchanged", () => {
    expect(parsePhoneList("+1234567890")).toEqual(["+1234567890"]);
  });

  it("splits on both commas and newlines", () => {
    expect(parsePhoneList("+1234567890, +1987654321\n+1555555555")).toEqual([
      "+1234567890",
      "+1987654321",
      "+1555555555",
    ]);
  });

  it("strips formatting characters (spaces, parens, dashes)", () => {
    expect(parsePhoneList("+1 (234) 567-8900")).toEqual(["+12345678900"]);
  });

  it("prefixes a leading + when missing, keeping only digits", () => {
    expect(parsePhoneList("2345678900")).toEqual(["+2345678900"]);
  });

  it("drops numbers shorter than 8 digits", () => {
    expect(parsePhoneList("+123")).toEqual([]);
  });

  it("drops numbers longer than 15 digits", () => {
    expect(parsePhoneList("+1234567890123456")).toEqual([]);
  });

  it("dedupes repeated numbers, preserving first-seen order", () => {
    expect(parsePhoneList("+1234567890\n+1234567890\n+1987654321")).toEqual([
      "+1234567890",
      "+1987654321",
    ]);
  });

  it("returns an empty array for empty / whitespace input", () => {
    expect(parsePhoneList("")).toEqual([]);
    expect(parsePhoneList("  \n , \n ")).toEqual([]);
  });
});

describe("defaultCallWindows / formatDefaultCallWindowsJson", () => {
  it("returns one window per weekday", () => {
    const windows = defaultCallWindows();
    expect(windows).toHaveLength(7);
    expect(windows.map((w) => w.day)).toEqual([
      "sun",
      "mon",
      "tue",
      "wed",
      "thu",
      "fri",
      "sat",
    ]);
  });

  it("formats the default windows as pretty JSON that round-trips", () => {
    const json = formatDefaultCallWindowsJson();
    expect(JSON.parse(json)).toEqual(defaultCallWindows());
  });
});

describe("normalizeOperatorControls", () => {
  it("passes valid values through as DB column keys", () => {
    expect(
      normalizeOperatorControls({
        retryIntervalMinutes: 30,
        maxAttempts: 5,
        dailyCap: 200,
        realtime: true,
      }),
    ).toEqual({ retry_interval_minutes: 30, max_attempts: 5, daily_cap: 200, realtime: true });
  });

  it("empty input → empty object (DB defaults win)", () => {
    expect(normalizeOperatorControls({})).toEqual({});
  });

  it("drops out-of-whitelist / out-of-range / falsy values", () => {
    expect(
      normalizeOperatorControls({
        retryIntervalMinutes: 45, // not in 30/60/90
        maxAttempts: 7, // > 5
        dailyCap: -1, // not positive
        realtime: false, // only true is sent
      }),
    ).toEqual({});
    expect(normalizeOperatorControls({ maxAttempts: 1, dailyCap: 2.5 })).toEqual({});
  });

  it("each key is independent", () => {
    expect(normalizeOperatorControls({ retryIntervalMinutes: 60 })).toEqual({
      retry_interval_minutes: 60,
    });
    expect(normalizeOperatorControls({ dailyCap: 1 })).toEqual({ daily_cap: 1 });
  });

  it("accepts callDelayMinutes 5 / 45 / 1440", () => {
    expect(normalizeOperatorControls({ callDelayMinutes: 5 })).toEqual({ call_delay_minutes: 5 });
    expect(normalizeOperatorControls({ callDelayMinutes: 45 })).toEqual({ call_delay_minutes: 45 });
    expect(normalizeOperatorControls({ callDelayMinutes: CALL_DELAY_MAX_MINUTES })).toEqual({
      call_delay_minutes: 1440,
    });
  });

  it("drops callDelayMinutes 0 / -5 / 2.5 / 1441 / null / undefined", () => {
    for (const bad of [0, -5, 2.5, 1441, null, undefined]) {
      expect(
        normalizeOperatorControls({ callDelayMinutes: bad as number | null | undefined }),
      ).toEqual({});
    }
  });
});

describe("resolveCallDelay", () => {
  it("maps pills", () => {
    expect(resolveCallDelay("now", "")).toEqual({ minutes: null, invalid: false });
    expect(resolveCallDelay("5", "")).toEqual({ minutes: 5, invalid: false });
    expect(resolveCallDelay("30", "ignored")).toEqual({ minutes: 30, invalid: false });
    expect(resolveCallDelay("60", "")).toEqual({ minutes: 60, invalid: false });
  });

  it("parses custom within 1..1440", () => {
    expect(resolveCallDelay("custom", " 45 ")).toEqual({ minutes: 45, invalid: false });
    expect(resolveCallDelay("custom", "1440")).toEqual({ minutes: 1440, invalid: false });
  });

  it("flags junk / out-of-range custom as invalid", () => {
    for (const bad of ["", "0", "-5", "2.5", "1441", "abc"]) {
      expect(resolveCallDelay("custom", bad)).toEqual({ minutes: null, invalid: true });
    }
  });
});
