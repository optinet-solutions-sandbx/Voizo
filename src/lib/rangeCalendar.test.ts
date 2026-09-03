import { describe, it, expect } from "vitest";
import {
  addDays, weekStart, monthEnd, granularityWindow, daysOfMonth, weeksOfMonth, countRuns, shiftMonth,
  windowCaption, isIsoDay, shortDay,
} from "./rangeCalendar";

describe("rangeCalendar — date arithmetic in UTC", () => {
  it("adds days across a month and a year boundary", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("weekStart is the Sunday, and a Sunday is its own start", () => {
    expect(weekStart("2026-08-19")).toBe("2026-08-16"); // Wed → Sun
    expect(weekStart("2026-08-16")).toBe("2026-08-16");
    expect(weekStart("2026-09-01")).toBe("2026-08-30"); // crosses a month
  });
  it("monthEnd knows February and leap years", () => {
    expect(monthEnd("2026-02-10")).toBe("2026-02-28");
    expect(monthEnd("2028-02-10")).toBe("2028-02-29");
    expect(monthEnd("2026-08-01")).toBe("2026-08-31");
  });
  it("isIsoDay rejects shapes and impossible dates", () => {
    expect(isIsoDay("2026-08-19")).toBe(true);
    expect(isIsoDay("2026-02-30")).toBe(false);
    expect(isIsoDay("19/08/2026")).toBe(false);
    expect(isIsoDay("")).toBe(false);
    expect(isIsoDay(null)).toBe(false);
  });
  it("shortDay reads like the mockup's button", () => {
    expect(shortDay("2026-08-16")).toBe("Aug 16");
  });
});

describe("granularityWindow — every pick compiles to one from→to pair", () => {
  it("day, week, month, year", () => {
    expect(granularityWindow("day", "2026-08-19")).toEqual(["2026-08-19", "2026-08-19"]);
    expect(granularityWindow("week", "2026-08-19")).toEqual(["2026-08-16", "2026-08-22"]);
    expect(granularityWindow("month", "2026-08-19")).toEqual(["2026-08-01", "2026-08-31"]);
    expect(granularityWindow("year", "2026-08-19")).toEqual(["2026-01-01", "2026-12-31"]);
  });
  it("range is order-normalised, and one endpoint is a one-day window", () => {
    expect(granularityWindow("range", "2026-08-22", "2026-08-16")).toEqual(["2026-08-16", "2026-08-22"]);
    expect(granularityWindow("range", "2026-08-16", "2026-08-22")).toEqual(["2026-08-16", "2026-08-22"]);
    expect(granularityWindow("range", "2026-08-16", null)).toEqual(["2026-08-16", "2026-08-16"]);
  });
});

describe("month grids", () => {
  it("daysOfMonth lists every day once", () => {
    const d = daysOfMonth("2026-08-15");
    expect(d).toHaveLength(31);
    expect(d[0]).toBe("2026-08-01");
    expect(d[30]).toBe("2026-08-31");
  });
  it("weeksOfMonth lists every week touching the month, starting on Sundays", () => {
    const w = weeksOfMonth("2026-08-15");
    expect(w[0]).toBe("2026-07-26"); // Aug 1 2026 is a Saturday, so its week starts in July
    expect(w[w.length - 1]).toBe("2026-08-30");
    expect(w.every((x) => weekStart(x) === x)).toBe(true);
  });
  it("shiftMonth moves by months across years", () => {
    expect(shiftMonth("2026-08", 1)).toBe("2026-09");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -12)).toBe("2025-01");
  });
});

describe("countRuns — run dates per day / week / month / year", () => {
  const dates = ["2026-08-16", "2026-08-16", "2026-08-19", "2026-09-01", "garbage", ""];
  it("counts by each key and skips junk", () => {
    expect(countRuns(dates, "day").get("2026-08-16")).toBe(2);
    expect(countRuns(dates, "week").get("2026-08-16")).toBe(3); // 16th and 19th share the week
    expect(countRuns(dates, "month").get("2026-08")).toBe(3);
    expect(countRuns(dates, "year").get("2026")).toBe(4);
    expect([...countRuns(dates, "day").keys()]).not.toContain("garbage");
  });
});

describe("windowCaption — the button reads the window", () => {
  it("one day, a range, open ends, all time", () => {
    expect(windowCaption("2026-08-16", "2026-08-22")).toBe("Aug 16 – Aug 22");
    expect(windowCaption("2026-08-16", "2026-08-16")).toBe("Aug 16");
    expect(windowCaption("2026-08-16", "")).toBe("Aug 16 – today");
    expect(windowCaption("", "2026-08-22")).toBe("up to Aug 22");
    expect(windowCaption("", "")).toBe("All time");
  });
});
