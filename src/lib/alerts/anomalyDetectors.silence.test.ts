import { describe, expect, it } from "vitest";
import { DIAL_SILENCE_MINUTES, detectDialSilence, type DialSilenceCandidate } from "./anomalyDetectors";

// VOZ-437 — detector C. Replays the 2026-08-24/25 deadlock (16.5h, zero calls, every
// cron green) and pins the four reasons a quiet campaign is NOT an incident.
const NOW = Date.parse("2026-08-24T23:15:00Z");
const MIN = 60 * 1000;

function child(over: Partial<DialSilenceCandidate> = {}): DialSilenceCandidate {
  return {
    id: "c1",
    name: "VOIZO REACTIVATION - NZ | Daily Automated (2026-08-25)",
    status: "draft",
    inWindowThroughout: true,
    startAtMs: Date.parse("2026-08-24T23:00:00Z"), // NZ window open
    recentCalls: 0,
    dueNumbers: 27,
    ...over,
  };
}

describe("detectDialSilence — VOZ-437 detector C (dial silence)", () => {
  it("REPLAYS 2026-08-24 23:15Z: 8 in-window drafts with players due and zero calls → trips, lists all 8", () => {
    const kids = Array.from({ length: 8 }, (_, i) => child({ id: `k${i}`, name: `child ${i}` }));
    const r = detectDialSilence(kids, NOW);
    expect(r.trip).toBe(true);
    expect(r.silent.map((c) => c.id)).toEqual(kids.map((c) => c.id));
  });

  it("a running child is judged the same way as a draft (a stalled dialer, not just a stalled promotion)", () => {
    expect(detectDialSilence([child({ status: "running" })], NOW).trip).toBe(true);
  });

  it("quiet because every player is on a retry timer (AU 08-25 08:16Z: 43 dialled, 0 due) → no trip", () => {
    expect(detectDialSilence([child({ status: "running", dueNumbers: 0 })], NOW).trip).toBe(false);
  });

  it("quiet but only startable for 5 minutes → no trip (promotion is one draft per tick)", () => {
    const r = detectDialSilence([child({ startAtMs: NOW - 5 * MIN })], NOW);
    expect(r.trip).toBe(false);
    // exactly DIAL_SILENCE_MINUTES is long enough — the boundary is inclusive
    expect(detectDialSilence([child({ startAtMs: NOW - DIAL_SILENCE_MINUTES * MIN })], NOW).trip).toBe(true);
  });

  it("just re-entered a split window (not in window 15 min ago) → no trip", () => {
    expect(detectDialSilence([child({ inWindowThroughout: false })], NOW).trip).toBe(false);
  });

  it("paused is deliberate silence (operator or reject breaker) → ignored", () => {
    expect(detectDialSilence([child({ status: "paused" })], NOW).trip).toBe(false);
  });

  it("any call in the window clears it", () => {
    expect(detectDialSilence([child({ recentCalls: 1 })], NOW).trip).toBe(false);
  });

  it("mixed fleet: reports only the silent ones", () => {
    const r = detectDialSilence(
      [child({ id: "ok", recentCalls: 12 }), child({ id: "stuck" }), child({ id: "retrying", dueNumbers: 0 })],
      NOW,
    );
    expect(r.silent.map((c) => c.id)).toEqual(["stuck"]);
  });

  it("empty fleet → no trip", () => {
    expect(detectDialSilence([], NOW)).toEqual({ trip: false, silent: [] });
  });
});
