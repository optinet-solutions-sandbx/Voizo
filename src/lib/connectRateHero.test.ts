import { describe, it, expect } from "vitest";
import { summarizeWindow, compareWindows, deltaLabel, baselineSeries, barSeries, type DayCount } from "./connectRateHero";

const day = (d: string, terminal: number, connected: number): DayCount => ({ day: d, terminal, connected });

describe("summarizeWindow — a window is its completed calls, its connects, and its outage days", () => {
  it("sums the days and reports the rate as connected over completed (prod's definition)", () => {
    const w = summarizeWindow([day("2026-08-19", 100, 80), day("2026-08-20", 100, 60)]);
    expect(w.terminal).toBe(200);
    expect(w.connected).toBe(140);
    expect(w.rate).toBeCloseTo(70);
    expect(w.deadDays).toEqual([]);
  });

  it("a day that completed calls and connected NONE is an outage day, and is named", () => {
    const w = summarizeWindow([day("2026-08-12", 2027, 0), day("2026-08-13", 100, 50)]);
    expect(w.deadDays).toEqual(["2026-08-12"]);
    expect(w.deadTerminal).toBe(2027);
    // the rate itself is NOT adjusted — it reports what the window did
    expect(w.rate).toBeCloseTo((50 / 2127) * 100);
  });

  it("a day with no calls at all is idle, not an outage", () => {
    const w = summarizeWindow([day("2026-08-16", 0, 0), day("2026-08-17", 10, 5)]);
    expect(w.deadDays).toEqual([]);
  });

  it("an empty window has no rate", () => {
    expect(summarizeWindow([]).rate).toBeNull();
    expect(summarizeWindow([day("2026-08-16", 0, 0)]).rate).toBeNull();
  });
});

describe("compareWindows — both sides drop their outage days before their rates are taken", () => {
  const normal = summarizeWindow([day("a", 100, 70), day("b", 100, 70)]); // 70%

  it("refuses when there is no baseline", () => {
    const g = compareWindows(normal, null);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.why).toMatch(/nothing to compare/i);
  });

  it("refuses a baseline with no completed calls", () => {
    const g = compareWindows(normal, summarizeWindow([day("z", 0, 0)]));
    expect(g.ok).toBe(false);
  });

  it("refuses a baseline that connected nothing — an outage is not a baseline", () => {
    const g = compareWindows(normal, summarizeWindow([day("z", 500, 0)]));
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.why).toMatch(/outage/i);
  });

  it("a plain comparison: current 70% vs baseline 60% = +10.0 pts", () => {
    const base = summarizeWindow([day("y", 100, 60), day("z", 100, 60)]);
    const g = compareWindows(normal, base);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.pts).toBeCloseTo(10.0);
      expect(g.dropped).toEqual([]);
    }
  });

  it("SYMMETRIC EXCLUSION: an outage day in the baseline does not read as improvement", () => {
    // baseline: one normal day at 70% plus the last day of a trunk outage (2,027 completed, 0 connected).
    // Unadjusted that baseline reads 70/2127 = 3.3%, and a normal 70% week would print +66.7 pts.
    const base = summarizeWindow([day("2026-08-12", 2027, 0), day("2026-08-13", 100, 70)]);
    const g = compareWindows(normal, base);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.pts).toBeCloseTo(0); // like for like: 70% vs 70%
      expect(g.dropped).toEqual([{ day: "2026-08-12", side: "baseline" }]);
      expect(g.droppedTerminal).toBe(2027);
    }
  });

  it("SYMMETRIC EXCLUSION: an outage day in the CURRENT window is dropped too", () => {
    const cur = summarizeWindow([day("2026-08-24", 300, 0), day("2026-08-25", 100, 70)]);
    const base = summarizeWindow([day("2026-08-17", 100, 70)]);
    const g = compareWindows(cur, base);
    expect(g.ok).toBe(true);
    if (g.ok) {
      expect(g.pts).toBeCloseTo(0);
      expect(g.dropped).toEqual([{ day: "2026-08-24", side: "window" }]);
    }
  });

  it("a current window whose every dialling day was dead compares as 0%, not as a crash", () => {
    const cur = summarizeWindow([day("a", 50, 0)]);
    const base = summarizeWindow([day("z", 100, 70)]);
    const g = compareWindows(cur, base);
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.pts).toBeCloseTo(-70);
  });
});

describe("deltaLabel — three states, not two", () => {
  it("up, down, and a rounds-to-zero delta is 'No change', never an arrow", () => {
    expect(deltaLabel(2.2)).toEqual({ dir: "up", text: "▲ 2.2 pts" });
    expect(deltaLabel(-0.4)).toEqual({ dir: "down", text: "▼ 0.4 pts" });
    expect(deltaLabel(0.04)).toEqual({ dir: "flat", text: "▪ No change" });
    expect(deltaLabel(-0.04)).toEqual({ dir: "flat", text: "▪ No change" });
    expect(deltaLabel(0)).toEqual({ dir: "flat", text: "▪ No change" });
  });
});

describe("baselineSeries — rollup rows to one per-day series, same scope as the window", () => {
  const rows = [
    { campaign_id: "A", day_utc: "2026-08-10", terminal: 100, connected: 60 },
    { campaign_id: "B", day_utc: "2026-08-10", terminal: 50, connected: 10 },
    { campaign_id: "A", day_utc: "2026-08-11", terminal: 80, connected: 40 },
    { campaign_id: "GHOST", day_utc: "2026-08-11", terminal: 999, connected: 999 },
  ];

  it("sums campaigns per day and sorts the days", () => {
    const s = baselineSeries(rows, () => true);
    expect(s.map((d) => d.day)).toEqual(["2026-08-10", "2026-08-11"]);
    expect(s[0]).toEqual({ day: "2026-08-10", terminal: 150, connected: 70 });
    expect(s[1].terminal).toBe(80 + 999);
  });

  it("drops whole campaigns the scope excludes, so a ghost cannot inflate the baseline", () => {
    const s = baselineSeries(rows, (id) => id !== "GHOST");
    expect(s[1]).toEqual({ day: "2026-08-11", terminal: 80, connected: 40 });
  });

  it("an empty rollup is an empty series, not a crash", () => {
    expect(baselineSeries([], () => true)).toEqual([]);
  });
});

describe("barSeries — what the hero can draw", () => {
  const mk = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ day: `2026-06-${String(from + i).padStart(2, "0")}`, terminal: 10, connected: 5 }));

  it("a short window is one bar per day, untouched", () => {
    const s = barSeries(mk(8));
    expect(s).toHaveLength(8);
    expect(s[0]).toEqual({ label: "2026-06-01", terminal: 10, connected: 5, days: 1 });
  });

  it("drops the idle days before the first completed call (the 1970 zero-fill)", () => {
    const idle = [{ day: "1970-01-01", terminal: 0, connected: 0 }, { day: "1970-01-02", terminal: 0, connected: 0 }];
    const s = barSeries([...idle, ...mk(3)]);
    expect(s.map((b) => b.label)).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("over the cap it buckets into weeks, summing counts (not averaging rates)", () => {
    const days = mk(20).map((d, i) => ({ ...d, terminal: 100, connected: i < 7 ? 50 : 100 })); // week 1 at 50%, then 100%
    const s = barSeries(days, 10);
    expect(s).toHaveLength(3); // 7 + 7 + 6
    expect(s[0]).toEqual({ label: "2026-06-01", terminal: 700, connected: 350, days: 7 });
    expect(s[2].days).toBe(6);
    expect(s[2].label).toBe("2026-06-15");
  });

  it("an all-idle series draws nothing rather than 20,699 stubs", () => {
    expect(barSeries(Array.from({ length: 20699 }, (_, i) => ({ day: `d${i}`, terminal: 0, connected: 0 })))).toEqual([]);
  });
});
