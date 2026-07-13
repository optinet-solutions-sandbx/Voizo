import { describe, expect, it } from "vitest";
import { buildParentEditUpdate } from "./parentEdit";
import type { RecurrencePattern } from "./types/recurrence";

const validPattern: RecurrencePattern = {
  start_date: "2026-07-13",
  end_kind: "never",
  end_date: null,
  end_after_n: null,
  repeat_every_weeks: 1,
  days_of_week: ["mon", "tue"],
  call_hours_by_day: {
    mon: { start: "09:00", end: "20:00" },
    tue: { start: "09:00", end: "20:00" },
  },
  exception_dates: [],
  skip_if_empty: true,
  segment_refresh_time: "08:30",
};

describe("buildParentEditUpdate", () => {
  it("empty input -> empty update, no error", () => {
    expect(buildParentEditUpdate({})).toEqual({ update: {} });
  });

  it("valid recurrence pattern maps to recurrence_pattern", () => {
    const r = buildParentEditUpdate({ recurrencePattern: validPattern });
    expect(r.error).toBeUndefined();
    expect(r.update.recurrence_pattern).toEqual(validPattern);
  });

  it("invalid recurrence pattern -> error naming the first problem", () => {
    const bad = { ...validPattern, days_of_week: [] as RecurrencePattern["days_of_week"] };
    const r = buildParentEditUpdate({ recurrencePattern: bad });
    expect(r.error).toMatch(/at least one day/i);
    expect(r.update.recurrence_pattern).toBeUndefined();
  });

  it("valid timezone maps; invalid timezone -> error", () => {
    expect(buildParentEditUpdate({ timezone: "Australia/Sydney" })).toEqual({
      update: { timezone: "Australia/Sydney" },
    });
    const r = buildParentEditUpdate({ timezone: "Mars/Olympus_Mons" });
    expect(r.error).toMatch(/timezone/i);
  });

  it("segmentId: positive int maps; junk -> error", () => {
    expect(buildParentEditUpdate({ segmentId: 394 })).toEqual({ update: { segment_id: 394 } });
    for (const bad of [0, -3, 2.5]) {
      expect(buildParentEditUpdate({ segmentId: bad }).error).toMatch(/segment/i);
    }
  });

  it("goalTarget: positive int maps; explicit null clears; junk -> error", () => {
    expect(buildParentEditUpdate({ goalTarget: 50 })).toEqual({ update: { goal_target: 50 } });
    expect(buildParentEditUpdate({ goalTarget: null })).toEqual({ update: { goal_target: null } });
    expect(buildParentEditUpdate({ goalTarget: 0 }).error).toMatch(/goal/i);
  });

  it("smsTemplate: non-empty sets; empty string or null clears", () => {
    expect(buildParentEditUpdate({ smsTemplate: "Hi {{name}}" })).toEqual({
      update: { sms_template: "Hi {{name}}" },
    });
    expect(buildParentEditUpdate({ smsTemplate: "  " })).toEqual({ update: { sms_template: null } });
    expect(buildParentEditUpdate({ smsTemplate: null })).toEqual({ update: { sms_template: null } });
  });

  it("first error wins across fields, nothing partial leaks", () => {
    const r = buildParentEditUpdate({ segmentId: -1, goalTarget: 5 });
    expect(r.error).toBeDefined();
    expect(r.update).toEqual({});
  });
});
