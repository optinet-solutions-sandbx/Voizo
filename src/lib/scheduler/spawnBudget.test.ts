import { describe, it, expect } from "vitest";
import { recurringBudgetExhausted, RECURRING_SPAWN_BUDGET_MS, SPAWN_SAFETY_MS } from "./spawnBudget";

// VOZ-520 — the number the whole "spawn runs hours late" bug hinged on. With a 60s
// tick, a spawn may only START while at most 25s have elapsed (60 − 30 − 5). Pinned
// here so a future retune of either constant is a deliberate, visible change.
describe("recurringBudgetExhausted (VOZ-520 spawn budget boundary)", () => {
  const TICK_SEC = 60;
  const threshold = TICK_SEC * 1000 - RECURRING_SPAWN_BUDGET_MS - SPAWN_SAFETY_MS;

  it("the 60s tick leaves exactly 25s in which a spawn may start", () => {
    expect(threshold).toBe(25_000);
  });

  it("at the threshold a spawn may still start; one millisecond later it may not", () => {
    expect(recurringBudgetExhausted(threshold, TICK_SEC)).toBe(false);
    expect(recurringBudgetExhausted(threshold + 1, TICK_SEC)).toBe(true);
  });

  it("a fresh tick always has budget", () => {
    expect(recurringBudgetExhausted(0, TICK_SEC)).toBe(false);
  });

  it("honours caller-supplied budget and cushion (the defaults are not baked in)", () => {
    // 60s tick, 10s budget, 0 cushion → exhausted only past 50s
    expect(recurringBudgetExhausted(50_000, TICK_SEC, 10_000, 0)).toBe(false);
    expect(recurringBudgetExhausted(50_001, TICK_SEC, 10_000, 0)).toBe(true);
  });
});
