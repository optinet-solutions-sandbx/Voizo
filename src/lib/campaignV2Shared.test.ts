import { describe, it, expect } from "vitest";
import {
  parsePhoneList,
  defaultCallWindows,
  formatDefaultCallWindowsJson,
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
