import { describe, expect, it } from "vitest";
import {
  buildChildPayload,
  clampCallEndToLegalCap,
  legalCallEndCap,
  type RecurringParent,
} from "./recurringSpawn";

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

describe("buildChildPayload script-mode inheritance (VOZ-184)", () => {
  it("script parent → child carries agent_mode + script_id + script_name", () => {
    const p = buildChildPayload({
      parent: { ...parent, agent_mode: "script", script_id: "scr-1", script_name: "Val - 20FS + 300% DB" },
      ...common,
    }) as Record<string, unknown>;
    expect(p.agent_mode).toBe("script");
    expect(p.script_id).toBe("scr-1");
    expect(p.script_name).toBe("Val - 20FS + 300% DB");
  });

  it("assistant parent → explicit assistant mode inherited (script pointers null)", () => {
    const p = buildChildPayload({
      parent: { ...parent, agent_mode: "assistant" },
      ...common,
    }) as Record<string, unknown>;
    expect(p.agent_mode).toBe("assistant");
    expect(p.script_id).toBeNull();
    expect(p.script_name).toBeNull();
  });

  it("legacy parent (agent_mode absent) → keys ABSENT so DB defaults apply unchanged", () => {
    const p = buildChildPayload({ parent, ...common }) as Record<string, unknown>;
    expect("agent_mode" in p).toBe(false);
    expect("script_id" in p).toBe(false);
    expect("script_name" in p).toBe(false);
  });
});

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

describe("buildChildPayload last-resort SMS inheritance (§8)", () => {
  it("children inherit a set template; absent otherwise (deploy-order safe)", () => {
    const withTemplate = buildChildPayload({
      parent: { ...parent, sms_last_resort_template: "Sorry we missed you! ..." },
      ...common,
    }) as Record<string, unknown>;
    expect(withTemplate.sms_last_resort_template).toBe("Sorry we missed you! ...");

    const without = buildChildPayload({ parent, ...common });
    expect("sms_last_resort_template" in without).toBe(false);
  });
});

describe("legalCallEndCap (VOZ-129 jurisdiction cap)", () => {
  it("caps AU/NZ/JP at 20:00 (8pm)", () => {
    expect(legalCallEndCap("Australia/Sydney")).toBe("20:00");
    expect(legalCallEndCap("Australia/Perth")).toBe("20:00"); // any AU zone
    expect(legalCallEndCap("Pacific/Auckland")).toBe("20:00");
    expect(legalCallEndCap("Asia/Tokyo")).toBe("20:00");
  });

  it("allows US/CA/UK to 21:00 (9pm)", () => {
    expect(legalCallEndCap("America/Toronto")).toBe("21:00");
    expect(legalCallEndCap("America/New_York")).toBe("21:00");
    expect(legalCallEndCap("Europe/London")).toBe("21:00");
  });

  it("defaults unmapped/empty zones to 21:00 (never tightens a previously-legal window)", () => {
    expect(legalCallEndCap("Asia/Dubai")).toBe("21:00");
    expect(legalCallEndCap("")).toBe("21:00");
    expect(legalCallEndCap(undefined as unknown as string)).toBe("21:00");
  });
});

describe("clampCallEndToLegalCap (compliance: clamp DOWN only)", () => {
  it("clamps an over-cap AU window end down to 20:00", () => {
    expect(clampCallEndToLegalCap("21:00", "Australia/Sydney")).toBe("20:00");
    expect(clampCallEndToLegalCap("20:30", "Australia/Sydney")).toBe("20:00");
  });

  it("leaves an at-cap or under-cap end untouched", () => {
    expect(clampCallEndToLegalCap("20:00", "Australia/Sydney")).toBe("20:00");
    expect(clampCallEndToLegalCap("18:00", "Australia/Sydney")).toBe("18:00");
  });

  it("does not clamp a legal 21:00 window in a 9pm jurisdiction (CA)", () => {
    expect(clampCallEndToLegalCap("21:00", "America/Toronto")).toBe("21:00");
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
