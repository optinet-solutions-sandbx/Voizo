import { describe, it, expect } from "vitest";
import { SNAPSHOT_RECIPIENTS, yesterdayWindowUtc, buildSnapshotEmail } from "./dailySnapshot";
import type { TodayPerfDay, PerfMetric, PerfRow, RateRow } from "./dashboardAnalytics";

function row(key: string, label: string, count: number, pct: number | null): PerfRow {
  return { key, label, count, pct, deltaPpVsYesterday: null, deltaPpVsSevenDayAvg: null };
}
function metric(total: number, rows: PerfRow[]): PerfMetric {
  return { total, deltaPctVsYesterday: null, deltaPctVsSevenDayAvg: null, rows };
}

// A full day's 3-card breakdown, matching computeWindowPerf's row keys.
function fullPerf(): TodayPerfDay {
  return {
    callAttempts: metric(166, [
      row("reached", "Reached", 57, 57 / 166),
      row("voicemail", "Voicemail", 98, 98 / 166),
      row("unreachable", "Unreachable", 11, 11 / 166),
    ]),
    reached: metric(57, [
      row("positive", "Positive", 1, 1 / 57),
      row("neutral", "Neutral", 50, 50 / 57),
      row("declined", "Declined", 4, 4 / 57),
      row("early_hangup", "Early hang-up", 2, 2 / 57),
    ]),
    sms: metric(125, [
      row("reached", "Reached", 40, 40 / 125),
      row("voicemail", "Voicemail", 70, 70 / 125),
      row("unreachable", "Unreachable", 15, 15 / 125),
    ]),
    inFlight: 0,
  };
}

function emptyPerf(): TodayPerfDay {
  return {
    callAttempts: metric(0, [
      row("reached", "Reached", 0, null),
      row("voicemail", "Voicemail", 0, null),
      row("unreachable", "Unreachable", 0, null),
    ]),
    reached: metric(0, [
      row("positive", "Positive", 0, null),
      row("neutral", "Neutral", 0, null),
      row("declined", "Declined", 0, null),
      row("early_hangup", "Early hang-up", 0, null),
    ]),
    sms: metric(0, [
      row("reached", "Reached", 0, null),
      row("voicemail", "Voicemail", 0, null),
      row("unreachable", "Unreachable", 0, null),
    ]),
    inFlight: 0,
  };
}

function kpis(connectRate: number | null, positiveResponseRate: number | null, voicemailRate: number | null): RateRow {
  return {
    calls: 0,
    connected: 0,
    terminal: 0,
    successful: 0,
    connectRate,
    successRate: null,
    voicemailConnected: 0,
    voicemailEvaluated: 0,
    reach: 0,
    voicemailRate,
    positiveResponseRate,
  };
}

describe("SNAPSHOT_RECIPIENTS", () => {
  it("is the 7 roosterpartners addresses from the ticket", () => {
    expect(SNAPSHOT_RECIPIENTS).toHaveLength(7);
    expect(SNAPSHOT_RECIPIENTS.every((e) => e.endsWith("@roosterpartners.com"))).toBe(true);
    expect(SNAPSHOT_RECIPIENTS).toContain("val@roosterpartners.com");
    expect(SNAPSHOT_RECIPIENTS).toContain("maria.grigorova@roosterpartners.com");
  });
});

describe("yesterdayWindowUtc", () => {
  it("returns the full previous UTC day for a mid-morning run", () => {
    const now = Date.UTC(2026, 6, 9, 7, 0, 0);
    const w = yesterdayWindowUtc(now);
    expect(w.startMs).toBe(Date.UTC(2026, 6, 8, 0, 0, 0, 0));
    expect(w.endMs).toBe(Date.UTC(2026, 6, 9, 0, 0, 0, 0) - 1);
    expect(w.dateLabel).toBe("8 Jul 2026");
  });

  it("crosses a month boundary correctly", () => {
    const now = Date.UTC(2026, 7, 1, 7, 0, 0);
    const w = yesterdayWindowUtc(now);
    expect(w.dateLabel).toBe("31 Jul 2026");
    expect(w.startMs).toBe(Date.UTC(2026, 6, 31, 0, 0, 0, 0));
  });
});

describe("buildSnapshotEmail — full metric breakdown", () => {
  it("renders every call-attempt / reached-quality / SMS bucket with percentages", () => {
    const { subject, html, text } = buildSnapshotEmail(
      fullPerf(),
      kpis(0.934, 0.0175, 0.632),
      "8 Jul 2026",
      "https://dash.example.com",
    );
    expect(subject).toContain("8 Jul 2026");

    // call attempts
    expect(html).toContain("166");
    expect(html).toContain("57 (34.3%)"); // reached
    expect(html).toContain("98 (59.0%)"); // voicemail
    expect(html).toContain("11 (6.6%)"); // unreachable
    // reached quality
    expect(html).toContain("1 (1.8%)"); // positive
    expect(html).toContain("50 (87.7%)"); // neutral
    expect(html).toContain("4 (7.0%)"); // declined
    expect(html).toContain("2 (3.5%)"); // early hang-up
    // sms
    expect(html).toContain("125");
    expect(html).toContain("40 (32.0%)");
    expect(html).toContain("70 (56.0%)");
    expect(html).toContain("15 (12.0%)");
    // key rates
    expect(html).toContain("93.4%"); // connect rate
    expect(html).toContain("63.2%"); // voicemail rate
    expect(html).toContain("https://dash.example.com");

    // plain-text alternative carries the same numbers, no HTML
    expect(text).toContain("Call attempts: 166");
    expect(text).toContain("Reached: 57 (34.3%)");
    expect(text).toContain("Reached quality: 57 reached");
    expect(text).toContain("Positive: 1 (1.8%)");
    expect(text).toContain("SMS: 125 sent/delivered");
    expect(text).toContain("Connect rate: 93.4%");
    expect(text).toContain("Voicemail rate: 63.2%");
    expect(text).toContain("https://dash.example.com");
    expect(text).not.toContain("<");
  });

  it("renders a zero-calls day without dividing by zero (html + text)", () => {
    const { html, text } = buildSnapshotEmail(emptyPerf(), kpis(null, null, null), "8 Jul 2026", "https://d");
    expect(html).toContain("0 (n/a)"); // null rate token
    expect(html).not.toContain("NaN");
    expect(text).toContain("Connect rate: n/a");
    expect(text).not.toContain("NaN");
  });
});
