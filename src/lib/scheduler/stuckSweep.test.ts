import { describe, it, expect } from "vitest";
import { decideStuckResolution } from "./stuckSweep";

// Fixed clock anchors (no Date.now() — the function is pure/deterministic).
const CUTOFF = "2026-06-17T12:00:00.000Z"; // latest call must have ended BEFORE this to resolve
const ENDED_LONG_AGO = "2026-06-17T11:00:00.000Z"; // before cutoff → grace passed
const ENDED_RECENTLY = "2026-06-17T12:03:00.000Z"; // after cutoff → still within grace

const base = { attemptCount: 0, maxAttempts: 3, sweepCutoffIso: CUTOFF };

describe("decideStuckResolution", () => {
  // ── running (unchanged legacy behavior) ──
  it("running + terminal call past grace, under max → pending_retry", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("pending_retry");
  });

  it("running + terminal call past grace, at max → unreached_max", () => {
    expect(
      decideStuckResolution({
        ...base,
        attemptCount: 3,
        campaignStatus: "running",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_max");
  });

  it("running + no calls_v2 row → pending (fireCall failed pre-INSERT, re-queue)", () => {
    expect(
      decideStuckResolution({ ...base, campaignStatus: "running", latestCall: null }),
    ).toBe("pending");
  });

  it("running + call still in flight → skip (chain-next will resolve)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "in_progress", ended_at: null },
      }),
    ).toBe("skip");
  });

  it("running + terminal call still within grace → skip (wait for late webhook)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "completed", ended_at: ENDED_RECENTLY },
      }),
    ).toBe("skip");
  });

  // ── paused (THE FIX: resolves exactly like running — restores Maria's retry) ──
  it("paused + terminal call past grace, under max → pending_retry (dials on resume)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "paused",
        latestCall: { status: "no_answer", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("pending_retry");
  });

  it("paused + terminal call past grace, at max → unreached_max", () => {
    expect(
      decideStuckResolution({
        ...base,
        attemptCount: 5,
        campaignStatus: "paused",
        latestCall: { status: "failed", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_max");
  });

  it("paused + no calls_v2 row → pending", () => {
    expect(
      decideStuckResolution({ ...base, campaignStatus: "paused", latestCall: null }),
    ).toBe("pending");
  });

  it("paused + call still in flight → skip", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "paused",
        latestCall: { status: "ringing", ended_at: null },
      }),
    ).toBe("skip");
  });

  // ── terminal campaigns (THE FIX: terminal `unreached`, never pending_retry) ──
  it("completed + terminal call past grace → unreached_terminal (never dials again)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_terminal");
  });

  it("completed + no calls_v2 row → unreached_terminal", () => {
    expect(
      decideStuckResolution({ ...base, campaignStatus: "completed", latestCall: null }),
    ).toBe("unreached_terminal");
  });

  it("inactive (ejected) + terminal call past grace → unreached_terminal", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "inactive",
        latestCall: { status: "busy", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_terminal");
  });

  it("completed + terminal call within grace → skip (still respects the 5-min grace)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "completed", ended_at: ENDED_RECENTLY },
      }),
    ).toBe("skip");
  });

  it("completed + call still in flight → skip (don't stomp a live outcome)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "answered", ended_at: null },
      }),
    ).toBe("skip");
  });

  it("draft / unknown status defaults to terminal unreached (safe — impossible-but-corrupt case)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "draft",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_terminal");
  });
});
