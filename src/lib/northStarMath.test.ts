// src/lib/northStarMath.test.ts
import { describe, it, expect } from "vitest";
import { classifySms, computeNorthStar } from "./northStarMath";

describe("classifySms", () => {
  it("noSms when empty", () => expect(classifySms([])).toBe("noSms"));
  it("delivered wins over failed/inflight", () => expect(classifySms(["failed", "delivered", "sent"])).toBe("delivered"));
  it("failed when no delivered", () => expect(classifySms(["undelivered"])).toBe("failed"));
  it("inFlight when only queued/sent", () => expect(classifySms(["queued"])).toBe("inFlight"));
  it("noSms when only unknown statuses", () => expect(classifySms([null, "weird"])).toBe("noSms"));
});

describe("computeNorthStar", () => {
  const campaigns = [
    { id: "c1", name: "US Camp", is_test: false },
    { id: "t1", name: "TEST", is_test: true },
  ];

  it("counts only goal-reached calls and classifies their SMS", () => {
    const calls = [
      { id: "a", campaign_id: "c1", goal_reached: true },
      { id: "b", campaign_id: "c1", goal_reached: true },
      { id: "c", campaign_id: "c1", goal_reached: false }, // ignored
      { id: "d", campaign_id: "c1", goal_reached: true }, // no sms
    ];
    const sms = [
      { call_id: "a", status: "delivered" },
      { call_id: "b", status: "failed" },
    ];
    const c1 = computeNorthStar({ calls, sms, campaigns }).perCampaign.find((c) => c.id === "c1")!;
    expect(c1.goalReached).toBe(3);
    expect(c1.delivered).toBe(1);
    expect(c1.failed).toBe(1);
    expect(c1.noSms).toBe(1);
    expect(c1.deliveredAmongGoal).toBe(0.3333);
  });

  it("excludes test campaigns + counts thin (below floor) separately", () => {
    const calls = [
      { id: "a", campaign_id: "c1", goal_reached: true },
      { id: "z", campaign_id: "t1", goal_reached: true },
    ];
    const sms = [
      { call_id: "a", status: "delivered" },
      { call_id: "z", status: "delivered" },
    ];
    const p = computeNorthStar({ calls, sms, campaigns }).portfolio;
    expect(p.excludedTestCampaigns).toBe(1);
    expect(p.goalReached).toBe(0); // c1 has 1 goal < floor 5 → thin, excluded from portfolio sums
    expect(p.excludedThinCampaigns).toBe(1);
  });

  it("deliveredAmongGoal is null (never NaN) when no goals", () =>
    expect(computeNorthStar({ calls: [], sms: [], campaigns }).portfolio.deliveredAmongGoal).toBeNull());

  it("counts a call once even with multiple sms rows", () => {
    const calls = [{ id: "a", campaign_id: "c1", goal_reached: true }];
    const sms = [
      { call_id: "a", status: "failed" },
      { call_id: "a", status: "delivered" },
    ];
    const c1 = computeNorthStar({ calls, sms, campaigns }).perCampaign.find((c) => c.id === "c1")!;
    expect(c1.delivered).toBe(1);
    expect(c1.goalReached).toBe(1);
  });
});
