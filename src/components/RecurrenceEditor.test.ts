import { describe, expect, it } from "vitest";
import { defaultRecurrencePattern } from "./RecurrenceEditor";

// VOZ-129: the recurring default call window must never exceed the strictest
// legal cap (20:00 / 8pm). Guards against a silent bump back to 21:00.
describe("defaultRecurrencePattern call hours (VOZ-129 legal cap)", () => {
  it("defaults every seeded day to 09:00-20:00", () => {
    const p = defaultRecurrencePattern(new Date("2026-07-15T00:00:00Z"), "Australia/Sydney");
    const hours = Object.values(p.call_hours_by_day);
    expect(hours.length).toBeGreaterThan(0);
    for (const h of hours) {
      expect(h).toEqual({ start: "09:00", end: "20:00" });
    }
  });
});
