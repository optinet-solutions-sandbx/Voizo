import { describe, expect, it } from "vitest";
import { concurrencyForCampaign, dialsToFire, fairShareConcurrency, resolveConcurrencyOverrides, resolveFleetLineBudget, resolvePerCampaignConcurrency } from "./perCampaignConcurrency";

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

describe("resolveConcurrencyOverrides — the per-campaign env map", () => {
  it("unset / blank / garbage → empty map (global default applies everywhere)", () => {
    expect(resolveConcurrencyOverrides(undefined)).toEqual({});
    expect(resolveConcurrencyOverrides("")).toEqual({});
    expect(resolveConcurrencyOverrides("no-colon-here")).toEqual({});
    expect(resolveConcurrencyOverrides(":3")).toEqual({});
    expect(resolveConcurrencyOverrides("id:")).toEqual({});
    expect(resolveConcurrencyOverrides("id:abc")).toEqual({});
  });

  it("parses one and many pairs, tolerating spaces", () => {
    expect(resolveConcurrencyOverrides("abc:3")).toEqual({ abc: 3 });
    expect(resolveConcurrencyOverrides(" abc : 3 , def:2 ")).toEqual({ abc: 3, def: 2 });
  });

  it("a bad pair never poisons the good ones", () => {
    expect(resolveConcurrencyOverrides("abc:3,junk,def:2,ghi:0")).toEqual({ abc: 3, def: 2 });
  });

  it("clamps to [1,10] like the global resolver — a fat-fingered env can't flood the trunk", () => {
    expect(resolveConcurrencyOverrides("abc:50")).toEqual({ abc: 10 });
    expect(resolveConcurrencyOverrides("abc:0")).toEqual({});
    expect(resolveConcurrencyOverrides("abc:-4")).toEqual({});
    expect(resolveConcurrencyOverrides("abc:2.9")).toEqual({ abc: 2 }); // parseInt truncates
  });

  it("the literal '<parentId>:3' placeholder is a provable no-op against real uuids", () => {
    const map = resolveConcurrencyOverrides("<parentId>:3");
    expect(map).toEqual({ "<parentid>": 3 });
    expect(concurrencyForCampaign("2a47b66b-9a81-4419-abfb-80d94b34b5b5", null, map, 1)).toBe(1);
  });

  it("keys lowercase at parse time — an uppercase UUID paste still matches Supabase ids", () => {
    const map = resolveConcurrencyOverrides("2A47B66B-9A81-4419-ABFB-80D94B34B5B5:3");
    expect(concurrencyForCampaign("x", "2a47b66b-9a81-4419-abfb-80d94b34b5b5", map, 1)).toBe(3);
  });

  it("ids colliding with inherited Object keys miss cleanly (null-prototype map)", () => {
    const map = resolveConcurrencyOverrides("abc:3");
    expect(concurrencyForCampaign("toString", null, map, 1)).toBe(1);
    expect(concurrencyForCampaign("x", "constructor", map, 2)).toBe(2);
  });
});

describe("concurrencyForCampaign — own id beats parent id beats global default", () => {
  const map = { parent1: 3, child1: 5 };

  it("recurring children match on their parent id (child ids change every spawn)", () => {
    expect(concurrencyForCampaign("fresh-child-uuid", "parent1", map, 1)).toBe(3);
  });

  it("own id wins over parent id (more specific)", () => {
    expect(concurrencyForCampaign("child1", "parent1", map, 1)).toBe(5);
  });

  it("no match anywhere → the global default, exactly the pre-override behaviour", () => {
    expect(concurrencyForCampaign("other", null, map, 1)).toBe(1);
    expect(concurrencyForCampaign("other", "unknown-parent", map, 2)).toBe(2);
    expect(concurrencyForCampaign("other", null, {}, 1)).toBe(1);
  });
});

describe("resolveFleetLineBudget — fleet budget env", () => {
  it("unset / blank / garbage / <1 → null (fair-share off, pre-budget behavior)", () => {
    expect(resolveFleetLineBudget(undefined)).toBeNull();
    expect(resolveFleetLineBudget("")).toBeNull();
    expect(resolveFleetLineBudget("abc")).toBeNull();
    expect(resolveFleetLineBudget("0")).toBeNull();
    expect(resolveFleetLineBudget("-8")).toBeNull();
  });

  it("parses and clamps to the 100 sanity ceiling", () => {
    expect(resolveFleetLineBudget("8")).toBe(8);
    expect(resolveFleetLineBudget("28")).toBe(28);
    expect(resolveFleetLineBudget("9999")).toBe(100);
  });
});

describe("fairShareConcurrency — the self-balancing allocator", () => {
  it("budget off (null) → the cap, byte-identical to the pre-budget code", () => {
    expect(fairShareConcurrency(null, 8, 1)).toBe(1);
    expect(fairShareConcurrency(null, 2, 3)).toBe(3);
  });

  it("night shift today: 8 campaigns share budget 8 → 1 each", () => {
    expect(fairShareConcurrency(8, 8, 3)).toBe(1);
  });

  it("CA shift today: 2 campaigns share budget 8 → capped at 3, not 4", () => {
    expect(fairShareConcurrency(8, 2, 3)).toBe(3);
  });

  it("liveness floor: more campaigns than budget still gets 1 each, never 0", () => {
    expect(fairShareConcurrency(8, 13, 3)).toBe(1);
  });

  it("after buying lines: budget 28 across 8 campaigns → 3 each", () => {
    expect(fairShareConcurrency(28, 8, 3)).toBe(3);
  });

  it("zero in-window campaigns never divides by zero", () => {
    expect(fairShareConcurrency(8, 0, 3)).toBe(3);
  });

  it("an explicit override still beats fair-share (operator intent wins)", () => {
    const fairK = fairShareConcurrency(8, 8, 3); // 1
    expect(concurrencyForCampaign("x", "special-parent", { "special-parent": 5 }, fairK)).toBe(5);
    expect(concurrencyForCampaign("x", null, {}, fairK)).toBe(1);
  });
});
