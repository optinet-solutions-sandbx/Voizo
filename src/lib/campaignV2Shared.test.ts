import { describe, it, expect } from "vitest";
import {
  parsePhoneList,
  nameByE164,
  cioIdByE164,
  defaultCallWindows,
  formatDefaultCallWindowsJson,
  normalizeOperatorControls,
  resolveCallDelay,
  buildSmsConsentPatch,
  CALL_DELAY_MAX_MINUTES,
  smsTemplateProblem,
} from "./campaignV2Shared";

// These tests pin the pure-helper contract that moved out of campaignV2Data.ts
// into the neutral, supabase-free campaignV2Shared module (RLS Phase A). The
// extraction must preserve behaviour byte-for-byte — client components value-
// import these and must NOT drag the server-only admin client into the bundle.

// nameByE164: joins raw Customer.io {phone, name} entries to the E.164 keys the
// insert pipeline actually stores (greet-by-name Ramp 1, 2026-07-17). Must use
// the SAME normalization as parsePhoneList so the map keys line up with
// campaign_numbers_v2.phone_e164 rows.
describe("nameByE164", () => {
  it("keys names by the parsePhoneList-normalized phone", () => {
    const map = nameByE164([
      { phone: "+1 (587) 208-3253", name: "kassandra sergerie lefrancois" },
      { phone: "12046511386", name: "Vicky Seavers" },
    ]);
    expect(map.get("+15872083253")).toBe("kassandra sergerie lefrancois");
    expect(map.get("+12046511386")).toBe("Vicky Seavers");
  });

  it("skips nameless and unparseable-phone entries; first name for a phone wins", () => {
    const map = nameByE164([
      { phone: "+15872083253", name: null },
      { phone: "not-a-phone", name: "Ghost" },
      { phone: "+12046511386", name: "First Wins" },
      { phone: "+12046511386", name: "Second Loses" },
    ]);
    expect(map.has("+15872083253")).toBe(false);
    expect(map.size).toBe(1);
    expect(map.get("+12046511386")).toBe("First Wins");
  });
});

describe("cioIdByE164", () => {
  // Email follow-up (2026-09-01): identity joins by the SAME normalized key and the SAME
  // first-wins rule as the name, so a duplicate phone resolves to ONE member for both.
  it("keys cio_ids by the parsePhoneList-normalized phone", () => {
    const map = cioIdByE164([
      { phone: "+1 (587) 208-3253", cioId: "cio-aaa" },
      { phone: "12046511386", cioId: "cio-bbb" },
    ]);
    expect(map.get("+15872083253")).toBe("cio-aaa");
    expect(map.get("+12046511386")).toBe("cio-bbb");
  });

  it("skips identity-less and unparseable entries; first id for a phone wins", () => {
    const map = cioIdByE164([
      { phone: "+15872083253", cioId: null },
      { phone: "not-a-phone", cioId: "cio-ghost" },
      { phone: "+12046511386", cioId: "cio-first" },
      { phone: "+12046511386", cioId: "cio-second" },
    ]);
    expect(map.has("+15872083253")).toBe(false);
    expect(map.size).toBe(1);
    expect(map.get("+12046511386")).toBe("cio-first");
  });
});

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

describe("buildSmsConsentPatch — edit-page SMS keys (2026-08-20 settings consolidation)", () => {
  it("no-op save sends neither key (VOZ-245: can't rewrite the column)", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "optin_reached_only",
        storedLastResortTemplate: null,
        draftMode: "optin_reached_only",
        lastResortEnabled: false,
        lastResortText: "",
      }),
    ).toEqual({});
  });

  it("legacy NULL stored mode reads as verbal_yes — a verbal_yes draft is unchanged, no 400 risk", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: null,
        storedLastResortTemplate: null,
        draftMode: "verbal_yes",
        lastResortEnabled: false,
        lastResortText: "",
      }),
    ).toEqual({});
  });

  it("switching a legacy mode to optin_reached_only sends the mode AND clears the stale template", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "optin_any_pickup",
        storedLastResortTemplate: "Sorry we missed you! ...",
        draftMode: "optin_reached_only",
        lastResortEnabled: true,
        lastResortText: "Sorry we missed you! ...",
      }),
    ).toEqual({ smsConsentMode: "optin_reached_only", smsLastResortTemplate: null });
  });

  it("switching to optin_reached_only with no stored template sends only the mode", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "optin_any_pickup",
        storedLastResortTemplate: null,
        draftMode: "optin_reached_only",
        lastResortEnabled: false,
        lastResortText: "",
      }),
    ).toEqual({ smsConsentMode: "optin_reached_only" });
  });

  it("staying on a legacy mode: toggle ON writes the trimmed text (VOZ-249)", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "optin_any_pickup",
        storedLastResortTemplate: "old",
        draftMode: "optin_any_pickup",
        lastResortEnabled: true,
        lastResortText: "  new text  ",
      }),
    ).toEqual({ smsLastResortTemplate: "new text" });
  });

  it("staying on a legacy mode: toggle OFF writes an explicit null, never an omitted key", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "registered_optin",
        storedLastResortTemplate: "old",
        draftMode: "registered_optin",
        lastResortEnabled: false,
        lastResortText: "old",
      }),
    ).toEqual({ smsLastResortTemplate: null });
  });

  it("toggle ON with a blank message fails safe to null (UI validation blocks this upstream)", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "optin_any_pickup",
        storedLastResortTemplate: null,
        draftMode: "optin_any_pickup",
        lastResortEnabled: true,
        lastResortText: "   ",
      }),
    ).toEqual({ smsLastResortTemplate: null });
  });

  it("a verbal_yes campaign with a stale stored template gets it cleared", () => {
    expect(
      buildSmsConsentPatch({
        storedMode: "verbal_yes",
        storedLastResortTemplate: "stale sorry-we-missed-you",
        draftMode: "verbal_yes",
        lastResortEnabled: true,
        lastResortText: "stale sorry-we-missed-you",
      }),
    ).toEqual({ smsLastResortTemplate: null });
  });
});

// 2026-08-27: the doubled-scheme dead link (VOZ ticket pending). Runs on the
// ASSEMBLED text so a scheme pasted into the message body is caught too.
describe("smsTemplateProblem", () => {
  it("flags https://https:// wherever it sits in the text", () => {
    expect(smsTemplateProblem("Ends midnight. https://https://Lucky-even.win/x STOP? Qwt5.me")).toMatch(/twice/);
    expect(smsTemplateProblem("https://https://lucky7even.org")).toMatch(/twice/);
    expect(smsTemplateProblem("http://https://lucky7even.org")).toMatch(/twice/); // mixed schemes, same defect
    expect(smsTemplateProblem("https:// https://lucky7even.org")).toMatch(/twice/); // with a stray space
  });
  it("passes a normal template, two distinct links, and empty input", () => {
    expect(smsTemplateProblem("Ends midnight. https://Lucky-even.win/promotions?bonus=LUCKY STOP? Qwt5.me")).toBeNull();
    expect(smsTemplateProblem("Offer https://a.example/x and terms https://b.example/y")).toBeNull();
    expect(smsTemplateProblem("")).toBeNull();
    expect(smsTemplateProblem(null)).toBeNull();
    expect(smsTemplateProblem(undefined)).toBeNull();
  });
});
