import { describe, it, expect } from "vitest";
import { computeMetricBreakdown } from "./metricBreakdown";
import type { BreakdownInput } from "./metricBreakdown";

// NOW = 2026-06-19T12:00:00Z → todayStart = 06-19T00:00Z, yesterday = 06-18, last7d = rolling [NOW-7d, NOW].
const NOW = Date.parse("2026-06-19T12:00:00Z");
const iso = (s: string) => new Date(s).toISOString();

const campaigns = [
  { id: "au", name: "L7_AU_Stevic", source: "production", is_test: false },
  { id: "ca", name: "L7_CA_Stevic", source: "production", is_test: false },
  { id: "ghost", name: "L7_AU_Ghost", source: "ghost_portal", is_test: false },
  { id: "test", name: "L7_AU_Test", source: "production", is_test: true },
];

const input: BreakdownInput = {
  now: NOW,
  campaigns,
  calls: [
    // AU today: 2 calls, 1 connected+goal, 1 connected-no-goal
    { campaign_id: "au", status: "completed", goal_reached: true, created_at: iso("2026-06-19T10:00:00Z") },
    { campaign_id: "au", status: "completed", goal_reached: false, created_at: iso("2026-06-19T08:00:00Z") },
    // AU yesterday: 1 call, no_answer
    { campaign_id: "au", status: "no_answer", goal_reached: null, created_at: iso("2026-06-18T10:00:00Z") },
    // CA 3 days ago (last7d only): 1 connected, no goal
    { campaign_id: "ca", status: "completed", goal_reached: null, created_at: iso("2026-06-16T10:00:00Z") },
    // AU 10 days ago: outside every window
    { campaign_id: "au", status: "completed", goal_reached: true, created_at: iso("2026-06-09T10:00:00Z") },
    // excluded: ghost + test (today)
    { campaign_id: "ghost", status: "completed", goal_reached: true, created_at: iso("2026-06-19T10:00:00Z") },
    { campaign_id: "test", status: "completed", goal_reached: true, created_at: iso("2026-06-19T10:00:00Z") },
  ],
  sms: [
    { campaign_id: "au", created_at: iso("2026-06-19T10:05:00Z") }, // AU today
    { campaign_id: "ca", created_at: iso("2026-06-16T10:05:00Z") }, // CA last7d
    { campaign_id: "ghost", created_at: iso("2026-06-19T10:05:00Z") }, // excluded
  ],
};

describe("computeMetricBreakdown — region × time", () => {
  const b = computeMetricBreakdown(input);
  const row = (region: string) => b.regions.find((r) => r.region === region);

  it("buckets calls into today / yesterday / rolling-7d by UTC day, excluding ghost + test", () => {
    expect(row("AU")!.today.calls).toBe(2);
    expect(row("AU")!.yesterday.calls).toBe(1);
    expect(row("AU")!.last7d.calls).toBe(3); // 2 today + 1 yesterday (10-days-ago excluded)
    expect(row("CA")!.today.calls).toBe(0);
    expect(row("CA")!.last7d.calls).toBe(1);
  });

  it("connectRate = connected / calls (the dashboard-card definition); successRate = goals / connected; null-safe", () => {
    expect(row("AU")!.today.connectRate).toBeCloseTo(2 / 2); // both completed
    expect(row("AU")!.today.successRate).toBeCloseTo(1 / 2); // 1 goal of 2 connected
    expect(row("AU")!.yesterday.connectRate).toBeCloseTo(0 / 1); // no_answer
    expect(row("CA")!.today.connectRate).toBeNull(); // 0 calls today → null, not NaN
    expect(row("CA")!.today.successRate).toBeNull();
  });

  it("messages counted per region × window (excludes ghost)", () => {
    expect(row("AU")!.today.messages).toBe(1);
    expect(row("CA")!.last7d.messages).toBe(1);
  });

  it("provides an ALL-regions total row", () => {
    expect(b.total.today.calls).toBe(2); // AU 2 + CA 0
    expect(b.total.last7d.calls).toBe(4); // AU last7d 3 + CA last7d 1
  });
});
