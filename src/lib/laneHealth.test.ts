import { describe, it, expect } from "vitest";
import { laneState, buildLaneHealth, LANE_RANK } from "./laneHealth";
import { CONNECT_COLLAPSE_MIN_DIALS } from "./alerts/anomalyDetectors";
import type { CallRollupRow, DashCampaignRow } from "./dashboardAnalytics";

describe("laneState — prod's collapse rule, judged on a closed day", () => {
  it("no dials is idle, not a verdict", () => expect(laneState(0, 0)).toBe("idle"));
  it("under the floor it declines to judge", () => {
    expect(laneState(CONNECT_COLLAPSE_MIN_DIALS - 1, 0)).toBe("thin");
    expect(laneState(3, 3)).toBe("thin");
  });
  it("at the floor with under half connected it is a collapse", () => {
    expect(laneState(CONNECT_COLLAPSE_MIN_DIALS, 0)).toBe("collapse");
    expect(laneState(72, 0)).toBe("collapse"); // the 24 Aug Canada trunk: 0 of 72
    expect(laneState(100, 49)).toBe("collapse");
  });
  it("half or more connected is ok", () => {
    expect(laneState(100, 50)).toBe("ok");
    expect(laneState(54, 48)).toBe("ok");
  });
  it("the floor is prod's constant", () => expect(CONNECT_COLLAPSE_MIN_DIALS).toBe(20));
});

const camp = (id: string, name: string, ws: string | null): DashCampaignRow => ({ id, name, cio_workspace: ws } as DashCampaignRow);
const row = (campaign_id: string, day_utc: string, attempts: number, connected: number): CallRollupRow => ({ campaign_id, day_utc, attempts, connected } as CallRollupRow);

describe("buildLaneHealth — one lane per brand × country, worst first", () => {
  const campaigns = [
    camp("fp-au", "Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU (2026-08-24)", "fortuneplay"),
    camp("l7-au", "Daily Automated Conversion | VOIZO RND REG YESTERDAY AU (2026-08-24)", "lucky7even"),
    camp("l7-ca", "Daily Automated Conversion | VOIZO RND REG YESTERDAY CA (2026-08-24)", "lucky7even"),
    camp("l7-au-2", "Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU (2026-08-24)", "lucky7even"),
  ];
  const rollup = [
    row("fp-au", "2026-08-24", 54, 48), row("fp-au", "2026-08-25", 48, 35),
    row("l7-au", "2026-08-24", 10, 9), row("l7-au-2", "2026-08-24", 10, 11), // two campaigns, one lane: 20 of 20
    row("l7-ca", "2026-08-24", 72, 0), row("l7-ca", "2026-08-25", 0, 0),
    row("l7-ca", "2026-08-20", 500, 400), // outside both days: ignored
    row("ghost", "2026-08-24", 999, 0), // not in the campaign list: ignored
  ];
  const lanes = buildLaneHealth(rollup, campaigns, "2026-08-24", "2026-08-25");

  it("folds campaigns into brand × country lanes and sums both days", () => {
    expect(lanes.map((l) => l.key)).toEqual(["lucky7even|Canada", "fortuneplay|Australia", "lucky7even|Australia"]);
    const fp = lanes.find((l) => l.key === "fortuneplay|Australia")!;
    expect(fp.yesterday).toEqual({ dials: 54, connected: 48, rate: 48 / 54 });
    expect(fp.today).toEqual({ dials: 48, connected: 35 });
    expect(fp.state).toBe("ok");
    const l7au = lanes.find((l) => l.key === "lucky7even|Australia")!;
    expect(l7au.yesterday.dials).toBe(20);
    expect(l7au.state).toBe("ok");
  });
  it("the dead Canada trunk is a collapse and sorts first", () => {
    expect(lanes[0].key).toBe("lucky7even|Canada");
    expect(lanes[0].state).toBe("collapse");
    expect(lanes[0].yesterday).toEqual({ dials: 72, connected: 0, rate: 0 });
    expect(lanes[0].today).toEqual({ dials: 0, connected: 0 });
  });
  it("rows outside the two days and unknown campaigns are ignored", () => {
    expect(lanes.every((l) => l.yesterday.dials < 500)).toBe(true);
    expect(lanes.some((l) => l.key.includes("Unknown"))).toBe(false);
  });
  it("collapse ranks before idle, thin, ok", () => {
    expect(LANE_RANK.collapse).toBeLessThan(LANE_RANK.idle);
    expect(LANE_RANK.idle).toBeLessThan(LANE_RANK.thin);
    expect(LANE_RANK.thin).toBeLessThan(LANE_RANK.ok);
  });
  it("no rollup rows means no lanes", () => expect(buildLaneHealth([], campaigns, "2026-08-24", "2026-08-25")).toEqual([]));
});
