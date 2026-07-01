import { describe, it, expect } from "vitest";
import { recordToCsv, recordCsvFilename, sliceMatches, sliceEq } from "./recordsDisplay";
import type { CallRecord, AttemptTag, CallAttempt } from "../../lib/dashboardAnalytics";

describe("recordToCsv — per-row CSV export (A1)", () => {
  it("serializes a contact's visible fields to a header + one data row", () => {
    const rec: CallRecord = {
      campaignNumberId: "cn1",
      phone: "+16398955660",
      status: "awaiting_retry",
      tag: "early_hangup",
      attempts: [
        { index: 1, tag: "early_hangup", atMs: Date.UTC(2026, 5, 26, 22, 0) },
        { index: 2, tag: "voicemail", atMs: Date.UTC(2026, 5, 26, 23, 38) },
      ],
      lastAttemptedMs: Date.UTC(2026, 5, 26, 23, 38),
    };
    // .trim() strips the leading CSV_BOM (﻿ is whitespace) + trailing CRLF.
    const [header, row] = recordToCsv(rec).trim().split("\r\n");
    expect(header).toBe('"Phone","Status","Attempt 1","Attempt 2","Last Attempted"');
    // Shared csvCell always-quotes + guards formula-injection: phone starts with "+" → prefixed with "'".
    expect(row).toBe(`"'+16398955660","Awaiting Retry","Early hangup","Voicemail detected","2026-06-26T23:38:00.000Z"`);
  });

  it("handles null phone, no attempts, and null lastAttempted", () => {
    const rec: CallRecord = {
      campaignNumberId: "cn2",
      phone: null,
      status: "unreached",
      tag: "unreachable",
      attempts: [],
      lastAttemptedMs: null,
    };
    const [header, row] = recordToCsv(rec).trim().split("\r\n");
    expect(header).toBe('"Phone","Status","Last Attempted"');
    // null phone + null lastAttempted → empty (unquoted) cells; "Unreached" quoted.
    expect(row).toBe(',"Unreached",');
  });
});

describe("recordCsvFilename", () => {
  it("builds a safe filename from the phone (alphanumerics only)", () => {
    const rec = { campaignNumberId: "cn1", phone: "+16398955660", status: "unreached", tag: "unreachable", attempts: [], lastAttemptedMs: null } as CallRecord;
    expect(recordCsvFilename(rec)).toBe("voizo_contact_16398955660.csv");
  });
  it("falls back to the campaignNumberId when phone is null", () => {
    const rec = { campaignNumberId: "cn-2", phone: null, status: "unreached", tag: "unreachable", attempts: [], lastAttemptedMs: null } as CallRecord;
    expect(recordCsvFilename(rec)).toBe("voizo_contact_cn2.csv");
  });
});

describe("sliceMatches — records slice filter (campaign expand click-to-filter)", () => {
  const rec = (over: Partial<CallRecord>): CallRecord => ({
    campaignNumberId: "cn", phone: "+1", status: "unreached", tag: "unreachable", attempts: [], lastAttemptedMs: null, ...over,
  });
  const att = (tag: AttemptTag): CallAttempt => ({ index: 1, tag, atMs: null });

  it("all → always true", () => {
    expect(sliceMatches(rec({}), { kind: "all" })).toBe(true);
  });
  it("outcome → matches a contact whose attempt carries the tag", () => {
    expect(sliceMatches(rec({ attempts: [att("voicemail")] }), { kind: "outcome", tag: "voicemail" })).toBe(true);
    expect(sliceMatches(rec({ attempts: [att("unreachable")] }), { kind: "outcome", tag: "voicemail" })).toBe(false);
  });
  it("reached → true iff a human-answered attempt (positive/neutral/declined/early_hangup)", () => {
    expect(sliceMatches(rec({ attempts: [att("early_hangup")] }), { kind: "reached" })).toBe(true);
    expect(sliceMatches(rec({ attempts: [att("positive")] }), { kind: "reached" })).toBe(true);
    expect(sliceMatches(rec({ attempts: [att("voicemail")] }), { kind: "reached" })).toBe(false);
    expect(sliceMatches(rec({ attempts: [att("unreachable")] }), { kind: "reached" })).toBe(false);
  });
  it("texted → keys off smsSent", () => {
    expect(sliceMatches(rec({ smsSent: true }), { kind: "texted" })).toBe(true);
    expect(sliceMatches(rec({ smsSent: false }), { kind: "texted" })).toBe(false);
    expect(sliceMatches(rec({}), { kind: "texted" })).toBe(false);
  });
});

describe("sliceEq — slice equality (highlight + toggle-close)", () => {
  it("same kind (and tag for outcome) → equal", () => {
    expect(sliceEq({ kind: "all" }, { kind: "all" })).toBe(true);
    expect(sliceEq({ kind: "reached" }, { kind: "reached" })).toBe(true);
    expect(sliceEq({ kind: "outcome", tag: "voicemail" }, { kind: "outcome", tag: "voicemail" })).toBe(true);
  });
  it("different kind or tag → not equal", () => {
    expect(sliceEq({ kind: "reached" }, { kind: "all" })).toBe(false);
    expect(sliceEq({ kind: "outcome", tag: "voicemail" }, { kind: "outcome", tag: "positive" })).toBe(false);
  });
  it("null handling", () => {
    expect(sliceEq(null, null)).toBe(true);
    expect(sliceEq(null, { kind: "all" })).toBe(false);
  });
});
