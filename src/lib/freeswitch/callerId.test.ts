import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveFreeswitchCallerId, callerIdForCountry, buildCallerIdMap } from "./callerId";

// Per-country outbound caller ID (deprecates the shared UK ANI, 2026-07-31).
// Destination country (detectCountry prefix match) picks the owned local DID:
// +1 (NA bucket) → FREESWITCH_CALLER_ID_CA, +61 → _AU, +64 → _NZ; anything
// else — or a mapped country whose env is absent — falls back to the default
// FREESWITCH_CALLER_ID. Reads env at call time so these tests can steer it.
describe("resolveFreeswitchCallerId (per-country caller ID)", () => {
  const ENV_KEYS = [
    "FREESWITCH_CALLER_ID",
    "FREESWITCH_CALLER_ID_CA",
    "FREESWITCH_CALLER_ID_AU",
    "FREESWITCH_CALLER_ID_NZ",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("AU destination uses the AU caller ID", () => {
    process.env.FREESWITCH_CALLER_ID = "+15550000000";
    process.env.FREESWITCH_CALLER_ID_AU = "+61272680150";
    expect(resolveFreeswitchCallerId("+61412345678")).toBe("+61272680150");
  });

  it("+1 destination (NA bucket — US and CA share the prefix) uses the CA caller ID", () => {
    process.env.FREESWITCH_CALLER_ID = "+15550000000";
    process.env.FREESWITCH_CALLER_ID_CA = "+16472436283";
    expect(resolveFreeswitchCallerId("+14165551234")).toBe("+16472436283");
  });

  // Provisioned 2026-08-19 (Maria): +6498026124, Auckland. Live-tested with
  // Gisela the same day. Uses the real DID like the AU/CA cases above so the
  // three mappings document the numbers we actually own.
  it("NZ destination uses the NZ caller ID", () => {
    process.env.FREESWITCH_CALLER_ID = "+15550000000";
    process.env.FREESWITCH_CALLER_ID_NZ = "+6498026124";
    expect(resolveFreeswitchCallerId("+6421555123")).toBe("+6498026124");
  });

  it("a country with no mapping (e.g. Spain +34) falls back to the default", () => {
    process.env.FREESWITCH_CALLER_ID = "+16472436283";
    expect(resolveFreeswitchCallerId("+34637534739")).toBe("+16472436283");
  });

  it("an unrecognized prefix (e.g. Gibraltar +350) falls back to the default", () => {
    process.env.FREESWITCH_CALLER_ID = "+16472436283";
    expect(resolveFreeswitchCallerId("+35054020611")).toBe("+16472436283");
  });

  it("a mapped country whose env var is absent falls back to the default (never a dead dial)", () => {
    process.env.FREESWITCH_CALLER_ID = "+16472436283";
    expect(resolveFreeswitchCallerId("+61412345678")).toBe("+16472436283");
  });

  it("whitespace-only country env counts as absent", () => {
    process.env.FREESWITCH_CALLER_ID = "+16472436283";
    process.env.FREESWITCH_CALLER_ID_AU = "   ";
    expect(resolveFreeswitchCallerId("+61412345678")).toBe("+16472436283");
  });

  it("nothing configured at all throws loudly, naming FREESWITCH_CALLER_ID (dialer parity)", () => {
    expect(() => resolveFreeswitchCallerId("+61412345678")).toThrow(/FREESWITCH_CALLER_ID/);
  });
});

// The country core that resolveFreeswitchCallerId delegates to, and that the
// wizard identity preview reuses so it can never disagree with the dialer.
describe("callerIdForCountry (country core)", () => {
  const KEYS = ["FREESWITCH_CALLER_ID", "FREESWITCH_CALLER_ID_CA", "FREESWITCH_CALLER_ID_AU", "FREESWITCH_CALLER_ID_NZ"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("NA→CA, AU→AU, NZ→NZ; unmapped country and null fall back to the default", () => {
    process.env.FREESWITCH_CALLER_ID = "+15550000000";
    process.env.FREESWITCH_CALLER_ID_CA = "+16472436283";
    process.env.FREESWITCH_CALLER_ID_AU = "+61272680150";
    process.env.FREESWITCH_CALLER_ID_NZ = "+6498026124";
    expect(callerIdForCountry("NA")).toEqual({ callerId: "+16472436283", error: null });
    expect(callerIdForCountry("AU")).toEqual({ callerId: "+61272680150", error: null });
    expect(callerIdForCountry("NZ")).toEqual({ callerId: "+6498026124", error: null });
    expect(callerIdForCountry("ES")).toEqual({ callerId: "+15550000000", error: null });
    expect(callerIdForCountry(null)).toEqual({ callerId: "+15550000000", error: null });
  });

  it("nothing configured returns an error and never throws (unlike the dialer wrapper)", () => {
    const r = callerIdForCountry("AU");
    expect(r.callerId).toBeNull();
    expect(r.error).toMatch(/FREESWITCH_CALLER_ID/);
  });
});

describe("buildCallerIdMap (wizard identity preview)", () => {
  const KEYS = ["FREESWITCH_CALLER_ID", "FREESWITCH_CALLER_ID_CA", "FREESWITCH_CALLER_ID_AU", "FREESWITCH_CALLER_ID_NZ"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("byCountry holds dedicated local numbers only (null when unprovisioned) plus the fallback", () => {
    process.env.FREESWITCH_CALLER_ID = "+16472436283";
    process.env.FREESWITCH_CALLER_ID_CA = "+16472436283";
    process.env.FREESWITCH_CALLER_ID_AU = "+61272680150";
    // NZ deliberately left unset: proves an unprovisioned country reports null
    // so the wizard says "shared number" instead of implying a local DID.
    const m = buildCallerIdMap();
    expect(m.byCountry.NA).toBe("+16472436283");
    expect(m.byCountry.AU).toBe("+61272680150");
    expect(m.byCountry.NZ).toBeNull();
    expect(m.fallback).toBe("+16472436283");
  });

  // Our actual configuration since 2026-08-19: all three markets own a local
  // DID, so the wizard shows "local number" for every one of them and never the
  // amber shared-number warning. Fails if a country is dropped from the env map.
  it("every market we own a number for reports it — no country silently falls back", () => {
    process.env.FREESWITCH_CALLER_ID = "+16472436283";
    process.env.FREESWITCH_CALLER_ID_CA = "+16472436283";
    process.env.FREESWITCH_CALLER_ID_AU = "+61272680150";
    process.env.FREESWITCH_CALLER_ID_NZ = "+6498026124";
    const m = buildCallerIdMap();
    expect(m.byCountry).toEqual({
      NA: "+16472436283",
      AU: "+61272680150",
      NZ: "+6498026124",
    });
    expect(Object.values(m.byCountry).some((v) => v === null)).toBe(false);
  });
});
