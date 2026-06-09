// src/lib/qa/driftAlert.test.ts
import { describe, it, expect } from "vitest";
import { shouldAlertDrift, selectPriorRun } from "./driftAlert";
import type { RunSummary } from "./goldenSetData";

const run = (judgeVersion: string, cohensKappa: number | null, n = 14): RunSummary => ({
  judgeVersion,
  judgeModel: "m",
  n,
  agreement: null,
  cohensKappa,
  createdAt: "2026-06-09T00:00:00Z",
});

describe("selectPriorRun", () => {
  it("returns the first (most-recent) run matching the judge_version", () => {
    const runs = [run("jvB", 0.5), run("jvA", 0.9), run("jvA", 0.7)];
    expect(selectPriorRun(runs, "jvA")?.cohensKappa).toBe(0.9);
  });
  it("returns null when no run matches", () => {
    expect(selectPriorRun([run("jvB", 0.5)], "jvA")).toBeNull();
  });
});

describe("shouldAlertDrift", () => {
  const base = { threshold: 0.6, minN: 10 };
  it("no alert when kappa is null", () =>
    expect(shouldAlertDrift({ ...base, latest: { kappa: null, n: 14 }, prior: null }).alert).toBe(false));
  it("no alert when n below floor", () =>
    expect(shouldAlertDrift({ ...base, latest: { kappa: 0.1, n: 5 }, prior: null }).alert).toBe(false));
  it("no alert when healthy", () =>
    expect(
      shouldAlertDrift({ ...base, latest: { kappa: 0.8, n: 14 }, prior: { kappa: 0.9, n: 14 } }).alert,
    ).toBe(false));
  it("alerts on a downward crossing from a healthy prior", () =>
    expect(
      shouldAlertDrift({ ...base, latest: { kappa: 0.4, n: 14 }, prior: { kappa: 0.8, n: 14 } }).alert,
    ).toBe(true));
  it("alerts when a brand-new judge_version lands below the bar (no prior)", () =>
    expect(shouldAlertDrift({ ...base, latest: { kappa: 0.3, n: 14 }, prior: null }).alert).toBe(true));
  it("does NOT re-alert when prior was already low (dedup)", () =>
    expect(
      shouldAlertDrift({ ...base, latest: { kappa: 0.35, n: 14 }, prior: { kappa: 0.4, n: 14 } }).alert,
    ).toBe(false));
});
