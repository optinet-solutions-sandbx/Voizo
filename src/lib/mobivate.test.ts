import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSmsSenderId } from "./mobivate";
import { CIO_DEFAULT_WORKSPACE } from "./customerio";

// Per-brand SMS originator. Mirrors resolveAppApiKey (VOZ-198): the brand is the
// campaigns_v2.cio_workspace label; a null/blank workspace is the default brand;
// a non-default brand NEVER borrows the default sender (wrong-brand guard). Reads
// env at call time so these tests can steer it.
describe("resolveSmsSenderId (per-brand SMS originator)", () => {
  const savedSingle = process.env.MOBIVATE_SENDER_ID;
  const savedMap = process.env.MOBIVATE_SENDER_IDS;

  beforeEach(() => {
    delete process.env.MOBIVATE_SENDER_ID;
    delete process.env.MOBIVATE_SENDER_IDS;
  });
  afterEach(() => {
    if (savedSingle === undefined) delete process.env.MOBIVATE_SENDER_ID;
    else process.env.MOBIVATE_SENDER_ID = savedSingle;
    if (savedMap === undefined) delete process.env.MOBIVATE_SENDER_IDS;
    else process.env.MOBIVATE_SENDER_IDS = savedMap;
  });

  it("default workspace falls back to the legacy single sender when no map exists", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    expect(resolveSmsSenderId()).toEqual({ senderId: "Lucky7even", error: null });
    expect(resolveSmsSenderId(CIO_DEFAULT_WORKSPACE)).toEqual({ senderId: "Lucky7even", error: null });
  });

  it("null / blank workspace mean the default workspace (campaign rows pass cio_workspace straight through)", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    expect(resolveSmsSenderId(null)).toEqual({ senderId: "Lucky7even", error: null });
    expect(resolveSmsSenderId("  ")).toEqual({ senderId: "Lucky7even", error: null });
  });

  it("default workspace prefers its map entry over the legacy sender", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ lucky7even: "L7Map" });
    expect(resolveSmsSenderId()).toEqual({ senderId: "L7Map", error: null });
  });

  it("a second brand resolves from its map entry", () => {
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ lucky7even: "Lucky7even", fortuneplay: "FortunePlay" });
    expect(resolveSmsSenderId("fortuneplay")).toEqual({ senderId: "FortunePlay", error: null });
  });

  it("a second brand NEVER falls back to the legacy sender (fail closed — the wrong-brand guard)", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    const res = resolveSmsSenderId("fortuneplay");
    expect(res.senderId).toBeNull();
    expect(res.error).toContain("fortuneplay");
    expect(res.error).toContain("MOBIVATE_SENDER_IDS");
  });

  it("an empty / non-string map entry counts as missing", () => {
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ fortuneplay: "" });
    expect(resolveSmsSenderId("fortuneplay").senderId).toBeNull();
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ fortuneplay: 42 });
    expect(resolveSmsSenderId("fortuneplay").senderId).toBeNull();
  });

  it("malformed map JSON: the default workspace still reaches the legacy sender, others fail closed", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    process.env.MOBIVATE_SENDER_IDS = "{not json";
    expect(resolveSmsSenderId()).toEqual({ senderId: "Lucky7even", error: null });
    expect(resolveSmsSenderId("fortuneplay").senderId).toBeNull();
  });

  it("no sender anywhere → error naming MOBIVATE_SENDER_ID for the default workspace", () => {
    const res = resolveSmsSenderId();
    expect(res.senderId).toBeNull();
    expect(res.error).toContain("MOBIVATE_SENDER_ID");
  });
});
