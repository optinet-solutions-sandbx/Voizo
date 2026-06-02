import { describe, it, expect } from "vitest";
import { buildAnalyticsCsv, buildAnalyticsJson, ANALYTICS_DEFINITIONS } from "./analyticsExport";
import { computeCampaignAnalytics } from "./campaignAnalytics";
import { FIXTURE_INPUT } from "./campaignAnalytics.fixtures";

const records = Object.values(computeCampaignAnalytics(FIXTURE_INPUT));

describe("buildAnalyticsCsv", () => {
  const csv = buildAnalyticsCsv(records);
  it("starts with the UTF-8 BOM", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });
  it("includes a definitions header and a column header row", () => {
    expect(csv).toContain("# conversion = goalCalls / connected");
    expect(csv).toContain('"campaign"');
    expect(csv).toContain('"conversion"');
  });
  it("has exactly one data row per record", () => {
    for (const a of records) expect(csv).toContain(a.name);
    const lines = csv.replace(/^﻿/, "").split("\r\n").filter((l) => l.length > 0);
    const bodyRows = lines.filter((l) => !l.startsWith("#")).length - 1; // minus the 1 header row
    expect(bodyRows).toBe(records.length);
  });
  it("applies the CSV formula-injection guard to a dangerous campaign name", () => {
    const danger = computeCampaignAnalytics({
      campaigns: [{ id: "x", name: "=cmd|calc", created_at: "2026-06-01T00:00:00Z" }],
      numbers: [], calls: [], sms: [], now: FIXTURE_INPUT.now,
    });
    const out = buildAnalyticsCsv(Object.values(danger));
    expect(out).toContain(`"'=cmd|calc"`); // leading apostrophe neutralizes the formula
  });
});

describe("buildAnalyticsJson", () => {
  const json = buildAnalyticsJson(records, "test-stamp");
  it("is valid JSON with definitions + campaigns", () => {
    const parsed = JSON.parse(json);
    expect(parsed._definitions.conversion).toBe(ANALYTICS_DEFINITIONS.conversion);
    expect(parsed.campaigns).toHaveLength(records.length);
    expect(parsed.generatedAtNote).toBe("test-stamp");
  });
  it("carries NO PII keys", () => {
    expect(json).not.toMatch(/phone_e164|transcript|\bbody\b|to_phone_e164/i);
  });
});
