import { describe, it, expect } from "vitest";
import { decideStuckResolution } from "./stuckSweep";

// Fixed clock anchors (no Date.now() — the function is pure/deterministic).
const SWEEP_CUTOFF = "2026-06-17T12:00:00.000Z"; // terminal call must have ENDED before this to resolve
const STALE_CUTOFF = "2026-06-17T11:35:00.000Z"; // non-terminal call CREATED before this is frozen/dead
const ENDED_LONG_AGO = "2026-06-17T11:00:00.000Z"; // before sweep cutoff → terminal grace passed
const ENDED_RECENTLY = "2026-06-17T12:03:00.000Z"; // after sweep cutoff → still within grace
const CREATED_OLD = "2026-04-23T14:00:00.000Z"; // before stale cutoff → frozen (like the real P2b rows)
const CREATED_RECENT = "2026-06-17T11:55:00.000Z"; // after stale cutoff → call may still be live

const base = { attemptCount: 0, maxAttempts: 3, sweepCutoffIso: SWEEP_CUTOFF, staleCutoffIso: STALE_CUTOFF };

describe("decideStuckResolution", () => {
  // ── running (legacy behavior, unchanged) ──
  it("running + terminal call past grace, under max → pending_retry", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO, created_at: ENDED_LONG_AGO },
      }),
    ).toBe("pending_retry");
  });

  it("running + terminal call past grace, at max → unreached_max", () => {
    expect(
      decideStuckResolution({
        ...base,
        attemptCount: 3,
        campaignStatus: "running",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO, created_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_max");
  });

  it("running + no calls_v2 row → pending (fireCall failed pre-INSERT, re-queue)", () => {
    expect(
      decideStuckResolution({ ...base, campaignStatus: "running", latestCall: null }),
    ).toBe("pending");
  });

  it("running + terminal call still within grace → skip (wait for late webhook)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "completed", ended_at: ENDED_RECENTLY, created_at: ENDED_RECENTLY },
      }),
    ).toBe("skip");
  });

  // ── paused (resolves like running — restores Maria's retry) ──
  it("paused + terminal call past grace, under max → pending_retry (dials on resume)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "paused",
        latestCall: { status: "no_answer", ended_at: ENDED_LONG_AGO, created_at: ENDED_LONG_AGO },
      }),
    ).toBe("pending_retry");
  });

  it("paused + no calls_v2 row → pending", () => {
    expect(
      decideStuckResolution({ ...base, campaignStatus: "paused", latestCall: null }),
    ).toBe("pending");
  });

  // ── terminal campaigns (terminal `unreached`, never pending_retry) ──
  it("completed + terminal call past grace → unreached_terminal (never dials again)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO, created_at: ENDED_LONG_AGO },
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
        latestCall: { status: "busy", ended_at: ENDED_LONG_AGO, created_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_terminal");
  });

  it("draft / unknown status defaults to terminal unreached (safe — impossible-but-corrupt case)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "draft",
        latestCall: { status: "completed", ended_at: ENDED_LONG_AGO, created_at: ENDED_LONG_AGO },
      }),
    ).toBe("unreached_terminal");
  });

  // ── live (non-terminal) calls within the staleness floor → never touched ──
  it("running + call still in flight, created recently → skip (chain-next will resolve)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "in_progress", ended_at: null, created_at: CREATED_RECENT },
      }),
    ).toBe("skip");
  });

  it("paused + call still in flight, created recently → skip", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "paused",
        latestCall: { status: "ringing", ended_at: null, created_at: CREATED_RECENT },
      }),
    ).toBe("skip");
  });

  it("completed + call still in flight, created recently → skip (don't stomp a live outcome)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "answered", ended_at: null, created_at: CREATED_RECENT },
      }),
    ).toBe("skip");
  });

  // ── P2b: frozen non-terminal calls past the staleness floor → reap ──
  it("running + non-terminal call frozen past stale floor → reap_pending (re-dial + mark row dead)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "running",
        latestCall: { status: "initiated", ended_at: null, created_at: CREATED_OLD },
      }),
    ).toBe("reap_pending");
  });

  it("paused + non-terminal call frozen past stale floor → reap_pending", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "paused",
        latestCall: { status: "ringing", ended_at: null, created_at: CREATED_OLD },
      }),
    ).toBe("reap_pending");
  });

  it("completed + non-terminal call frozen past stale floor → reap_unreached (the real P2b case)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "initiated", ended_at: null, created_at: CREATED_OLD },
      }),
    ).toBe("reap_unreached");
  });

  it("inactive + non-terminal call frozen past stale floor → reap_unreached", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "inactive",
        latestCall: { status: "initiated", ended_at: null, created_at: CREATED_OLD },
      }),
    ).toBe("reap_unreached");
  });

  it("missing created_at on a non-terminal call → skip (never reap on unknown age)", () => {
    expect(
      decideStuckResolution({
        ...base,
        campaignStatus: "completed",
        latestCall: { status: "initiated", ended_at: null, created_at: null },
      }),
    ).toBe("skip");
  });
});
