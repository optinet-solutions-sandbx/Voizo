import { describe, it, expect } from "vitest";
import { computeMarketComparison, type DashCallRow, type DashCampaignRow } from "./dashboardAnalytics";

const camp = (id: string, name: string): DashCampaignRow => ({ id, name } as DashCampaignRow);
const call = (campaign_id: string, status: string): DashCallRow => ({ id: Math.random().toString(36), campaign_id, status, created_at: "2026-08-20T10:00:00Z" } as DashCallRow);

describe("computeMarketComparison — per-country calls, connected, completed", () => {
  const campaigns = [
    camp("au", "Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU (2026-08-20)"),
    camp("ca", "Daily Automated Conversion | VOIZO RND REG YESTERDAY CA (2026-08-20)"),
    camp("x", "totally unparseable name"),
  ];
  it("groups by the campaign's country, counts connected and completed, sorts by calls", () => {
    const calls = [
      call("au", "completed"), call("au", "completed"), call("au", "no_answer"),
      call("ca", "completed"),
      call("x", "busy"),
    ];
    const m = computeMarketComparison(calls, campaigns);
    expect(m.map((r) => r.country)).toEqual(["Australia", "Canada", "other"]);
    const au = m[0];
    expect(au.calls).toBe(3);
    expect(au.connected).toBe(2);
    expect(au.terminal).toBe(3);
  });
  it("a market with no calls is not a row, and no calls at all is an empty list", () => {
    expect(computeMarketComparison([], campaigns)).toEqual([]);
  });
});
