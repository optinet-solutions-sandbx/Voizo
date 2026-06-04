import { describe, it, expect } from "vitest";
import { shouldAlertSpawnFail } from "./slack";

// shouldAlertSpawnFail is the generic time-window dedup predicate. It was
// originally written for recurring spawn_failed alerts; the campaign-scheduler
// "outside_call_window" alert (2026-06-04) reuses it as a 2nd caller. These
// tests lock the contract both callers depend on. nowMs is passed explicitly
// so the tests are deterministic (no Date.now()).
describe("shouldAlertSpawnFail (dedup predicate, shared by recurring + scheduler alerts)", () => {
  const now = Date.parse("2026-06-04T12:00:00.000Z");
  const HOUR = 60 * 60 * 1000;

  it("alerts when there is no prior alert (null)", () => {
    expect(shouldAlertSpawnFail(null, now)).toBe(true);
  });

  it("suppresses when the last alert is within the default 6h window", () => {
    const oneHourAgo = new Date(now - 1 * HOUR).toISOString();
    expect(shouldAlertSpawnFail(oneHourAgo, now)).toBe(false);
  });

  it("re-alerts when the last alert is older than the default 6h window", () => {
    const sevenHoursAgo = new Date(now - 7 * HOUR).toISOString();
    expect(shouldAlertSpawnFail(sevenHoursAgo, now)).toBe(true);
  });

  it("treats exactly-at-window as still suppressed (strict greater-than)", () => {
    const exactlySixHoursAgo = new Date(now - 6 * HOUR).toISOString();
    expect(shouldAlertSpawnFail(exactlySixHoursAgo, now)).toBe(false);
  });

  it("honors a custom window for the scheduler caller", () => {
    const ninetyMinAgo = new Date(now - 90 * 60 * 1000).toISOString();
    expect(shouldAlertSpawnFail(ninetyMinAgo, now, 1 * HOUR)).toBe(true); // older than 1h -> alert
    expect(shouldAlertSpawnFail(ninetyMinAgo, now, 2 * HOUR)).toBe(false); // within 2h -> suppress
  });
});
