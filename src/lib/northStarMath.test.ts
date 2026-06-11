// src/lib/northStarMath.test.ts
import { describe, it, expect } from "vitest";
import { classifySms, computeNorthStar, excludeGhostRows } from "./northStarMath";

describe("excludeGhostRows", () => {
  const campaigns = [
    { id: "c1", name: "US Camp", is_test: false, source: "production" },
    { id: "g1", name: "ghost run", is_test: false, source: "ghost_portal" }, // live tier ⇒ is_test=false
    { id: "c2", name: "legacy", is_test: false }, // pre-source row (null/undefined) ⇒ kept
  ];
  const calls = [
    { id: "a", campaign_id: "c1", goal_reached: true },
    { id: "x", campaign_id: "g1", goal_reached: true }, // ghost call
    { id: "b", campaign_id: "c2", goal_reached: true },
  ];
  const sms = [
    { call_id: "a", status: "delivered" },
    { call_id: "x", status: "delivered" }, // sms tied to the ghost call
    { call_id: null, status: "queued" }, // unlinked — kept (computeNorthStar already skips it)
  ];

  it("drops ghost campaigns, their calls, and the sms keyed to those calls", () => {
    const out = excludeGhostRows({ calls, sms, campaigns });
    expect(out.campaigns.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(out.calls.map((c) => c.id)).toEqual(["a", "b"]);
    expect(out.sms.map((m) => m.call_id)).toEqual(["a", null]);
  });

  it("a live-tier ghost campaign never reaches perCampaign (name leak guard)", () => {
    const result = computeNorthStar(excludeGhostRows({ calls, sms, campaigns }));
    expect(result.perCampaign.find((c) => c.id === "g1")).toBeUndefined();
    expect(result.perCampaign.find((c) => c.name === "ghost run")).toBeUndefined();
  });

  it("no-op when nothing is ghost", () => {
    const clean = { calls: calls.slice(0, 1), sms: sms.slice(0, 1), campaigns: campaigns.slice(0, 1) };
    const out = excludeGhostRows(clean);
    expect(out.calls).toHaveLength(1);
    expect(out.sms).toHaveLength(1);
    expect(out.campaigns).toHaveLength(1);
  });
});

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
