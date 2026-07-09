import { describe, it, expect } from "vitest";
import { SNAPSHOT_RECIPIENTS, yesterdayWindowUtc, buildSnapshotEmail } from "./dailySnapshot";
import type { TodayPerfDay, PerfRow } from "./dashboardAnalytics";

function row(key: string, label: string, count: number, pct: number | null): PerfRow {
  return { key, label, count, pct, deltaPpVsYesterday: null, deltaPpVsSevenDayAvg: null };
}
function perf(
  total: number,
  reached: number,
  voicemail: number,
  positive: number,
  posPct: number | null,
): TodayPerfDay {
  return {
    callAttempts: {
      total,
      deltaPctVsYesterday: null,
      deltaPctVsSevenDayAvg: null,
      rows: [
        row("reached", "Reached", reached, total ? reached / total : null),
        row("voicemail", "Voicemail", voicemail, total ? voicemail / total : null),
        row("unreachable", "Unreachable", total - reached - voicemail, null),
      ],
    },
    reached: {
      total: reached,
      deltaPctVsYesterday: null,
      deltaPctVsSevenDayAvg: null,
      rows: [row("positive", "Positive", positive, posPct)],
    },
    sms: { total: 0, deltaPctVsYesterday: null, deltaPctVsSevenDayAvg: null, rows: [] },
    inFlight: 0,
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
    const now = Date.UTC(2026, 6, 9, 7, 0, 0); // 2026-07-09 07:00 UTC
    const w = yesterdayWindowUtc(now);
    expect(w.startMs).toBe(Date.UTC(2026, 6, 8, 0, 0, 0, 0));
    expect(w.endMs).toBe(Date.UTC(2026, 6, 9, 0, 0, 0, 0) - 1);
    expect(w.dateLabel).toBe("8 Jul 2026");
  });

  it("crosses a month boundary correctly", () => {
    const now = Date.UTC(2026, 7, 1, 7, 0, 0); // 2026-08-01 07:00 UTC
    const w = yesterdayWindowUtc(now);
    expect(w.dateLabel).toBe("31 Jul 2026");
    expect(w.startMs).toBe(Date.UTC(2026, 6, 31, 0, 0, 0, 0));
  });
});

describe("buildSnapshotEmail", () => {
  it("renders all four headline numbers + the positive rate + the dashboard link", () => {
    const { subject, html } = buildSnapshotEmail(
      perf(200, 120, 60, 30, 0.25),
      45,
      "8 Jul 2026",
      "https://dash.example.com",
    );
    expect(subject).toContain("8 Jul 2026");
    expect(html).toContain("200"); // calls made
    expect(html).toContain("120"); // reached
    expect(html).toContain("60"); // voicemail
    expect(html).toContain("30"); // positive count
    expect(html).toContain("25.0%"); // positive rate
    expect(html).toContain("45"); // sms sent
    expect(html).toContain("https://dash.example.com");
  });

  it("renders a zero-calls day without dividing by zero", () => {
    const { html } = buildSnapshotEmail(perf(0, 0, 0, 0, null), 0, "8 Jul 2026", "https://d");
    expect(html).toContain("0");
    expect(html).toContain("&mdash;"); // rate shown as em-dash, not NaN%
    expect(html).not.toContain("NaN");
  });
});
