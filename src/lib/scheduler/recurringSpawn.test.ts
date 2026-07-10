import { describe, expect, it } from "vitest";
import { buildChildPayload, type RecurringParent } from "./recurringSpawn";

const parent: RecurringParent = {
  id: "p1",
  name: "L7_CA_RT",
  timezone: "America/Toronto",
  recurrence_pattern: null,
  segment_id: 42,
  base_assistant_id: "base",
  voice_id: null,
  system_prompt: "prompt",
  sms_enabled: true,
  sms_template: "t",
  sms_on_goal_reached_only: true,
  sms_consent_mode: "registered_optin",
  is_test: false,
};

const common = {
  todayStr: "2026-07-10",
  startAtIso: "2026-07-10T13:00:00.000Z",
  endAtIso: "2026-07-11T01:00:00.000Z",
  todaysCallWindow: [{ day: "fri" as const, start: "09:00", end: "21:00" }],
  status: "draft" as const,
  assistantId: "a",
  slotId: "s",
  sipUri: "sip:x",
};

describe("buildChildPayload realtime passthrough", () => {
  it("non-realtime parent: payload has NO realtime/daily_cap keys (deploy-order safe)", () => {
    const p = buildChildPayload({ parent, ...common });
    expect("realtime" in p).toBe(false);
    expect("daily_cap" in p).toBe(false);
  });

  it("realtime parent: child carries realtime=true + the cap, stays campaign_type fixed", () => {
    const p = buildChildPayload({
      parent: { ...parent, realtime: true, daily_cap: 150 },
      ...common,
    }) as Record<string, unknown>;
    expect(p.realtime).toBe(true);
    expect(p.daily_cap).toBe(150);
    expect(p.campaign_type).toBe("fixed");
    expect(p.parent_campaign_id).toBe("p1");
  });

  it("realtime parent with no cap: daily_cap key present as null (operator chose uncapped)", () => {
    const p = buildChildPayload({
      parent: { ...parent, realtime: true },
      ...common,
    }) as Record<string, unknown>;
    expect(p.realtime).toBe(true);
    expect(p.daily_cap).toBeNull();
  });
});

describe("buildChildPayload operator-control inheritance", () => {
  it("children inherit the parent's retry gap and max tries (dialer reads the CHILD row)", () => {
    const p = buildChildPayload({
      parent: { ...parent, retry_interval_minutes: 30, max_attempts: 5 },
      ...common,
    }) as Record<string, unknown>;
    expect(p.retry_interval_minutes).toBe(30);
    expect(p.max_attempts).toBe(5);
  });

  it("parents without explicit values fall back to the system defaults 90/3", () => {
    const p = buildChildPayload({ parent, ...common }) as Record<string, unknown>;
    expect(p.retry_interval_minutes).toBe(90);
    expect(p.max_attempts).toBe(3);
  });
});
