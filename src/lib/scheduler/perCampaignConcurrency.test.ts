import { describe, expect, it } from "vitest";
import { dialsToFire, resolvePerCampaignConcurrency } from "./perCampaignConcurrency";

describe("resolvePerCampaignConcurrency — the operator knob (default 1)", () => {
  it("defaults to 1 when unset — so shipping the code is a NO-OP until raised", () => {
    expect(resolvePerCampaignConcurrency(undefined)).toBe(1);
    expect(resolvePerCampaignConcurrency("")).toBe(1);
  });

  it("reads a valid integer", () => {
    expect(resolvePerCampaignConcurrency("2")).toBe(2);
    expect(resolvePerCampaignConcurrency("3")).toBe(3);
  });

  it("clamps to at least 1 — 0 or negative would stop all dialing", () => {
    expect(resolvePerCampaignConcurrency("0")).toBe(1);
    expect(resolvePerCampaignConcurrency("-4")).toBe(1);
  });

  it("caps at 10 (Vapi's concurrency ceiling) so a fat-fingered env can't flood the trunk", () => {
    expect(resolvePerCampaignConcurrency("50")).toBe(10);
    expect(resolvePerCampaignConcurrency("11")).toBe(10);
  });

  it("garbage falls back to the safe default of 1, never NaN", () => {
    expect(resolvePerCampaignConcurrency("abc")).toBe(1);
    expect(resolvePerCampaignConcurrency("2.9")).toBe(2); // parseInt truncates
  });
});

describe("dialsToFire — top up in-flight to the concurrency target", () => {
  it("at K=1 reproduces today's behaviour exactly (the regression pin)", () => {
    // Today: fire iff nothing is in flight. dialsToFire must mirror that at K=1.
    expect(dialsToFire(0, 1)).toBe(1); // idle → fire one
    expect(dialsToFire(1, 1)).toBe(0); // one live → fire none
    expect(dialsToFire(2, 1)).toBe(0); // over (race) → fire none
  });

  it("tops up the shortfall at K>1", () => {
    expect(dialsToFire(0, 3)).toBe(3); // idle → fill all three lanes
    expect(dialsToFire(1, 3)).toBe(2); // chain-next holds one → add two
    expect(dialsToFire(2, 3)).toBe(1);
    expect(dialsToFire(3, 3)).toBe(0); // at target → add none
  });

  it("never returns negative when already over target (overlapping-tick race)", () => {
    expect(dialsToFire(5, 3)).toBe(0);
  });
});
