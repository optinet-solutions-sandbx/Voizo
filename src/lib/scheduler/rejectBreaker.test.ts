import { describe, expect, it } from "vitest";
import { isFailureStreak, REJECT_BREAKER_STREAK, TERMINAL_CALL_STATUSES } from "./rejectBreaker";

const failed = (n: number) => Array<string>(n).fill("failed");

describe("isFailureStreak — VOZ-278 circuit breaker predicate", () => {
  it("trips on exactly the streak length of consecutive failures", () => {
    expect(isFailureStreak(failed(REJECT_BREAKER_STREAK))).toBe(true);
  });
  it("does not trip one short of the streak", () => {
    expect(isFailureStreak(failed(REJECT_BREAKER_STREAK - 1))).toBe(false);
  });
  it("a single recent success breaks the streak (statuses are newest-first)", () => {
    expect(isFailureStreak(["completed", ...failed(REJECT_BREAKER_STREAK)])).toBe(false);
  });
  it("older successes beyond the streak window do not matter", () => {
    expect(isFailureStreak([...failed(REJECT_BREAKER_STREAK), "completed"])).toBe(true);
  });
  it("a null status (unknown) breaks the streak defensively", () => {
    const statuses: Array<string | null> = [...failed(5)];
    statuses.splice(2, 0, null);
    statuses.push(...failed(REJECT_BREAKER_STREAK));
    expect(isFailureStreak(statuses.slice(0, REJECT_BREAKER_STREAK))).toBe(false);
  });
  it("empty input never trips", () => {
    expect(isFailureStreak([])).toBe(false);
  });

  // ── VOZ-369 regression guards, taken from production rows ──────────────────

  it("no business outcome other than 'failed' can trip it", () => {
    // mapHangup routes normal traffic to these: USER_BUSY → busy, NO_ANSWER and an
    // unanswered NORMAL_CLEARING → no_answer, ORIGINATOR_CANCEL → canceled. 2026-08-13
    // was 679 completed / 74 no_answer / 6 failed and must never have tripped.
    for (const ok of ["completed", "busy", "no_answer", "canceled"]) {
      expect(isFailureStreak(Array<string>(REJECT_BREAKER_STREAK).fill(ok))).toBe(false);
    }
  });

  it("trips on originate-layer failures, which carry NO hangup_cause at all", () => {
    // THE 2026-08-12 CASE. fireCall's provider-failure catch writes status 'failed'
    // and deliberately leaves hangup_cause NULL, so the old cause-keyed predicate was
    // blind: 2,027 consecutive such dials produced zero trips. Keying on status is
    // what makes this class visible — the predicate never sees hangup_cause.
    expect(isFailureStreak(failed(REJECT_BREAKER_STREAK))).toBe(true);
  });

  it("an in-flight status can never sustain a streak", () => {
    // Belt and braces: the caller filters to TERMINAL_CALL_STATUSES so these rows
    // should not arrive, but if one ever did it must break the streak, not extend it.
    for (const live of ["initiated", "ringing", "in_progress", "answered"]) {
      expect(isFailureStreak([live, ...failed(REJECT_BREAKER_STREAK)])).toBe(false);
    }
  });

  it("the terminal allowlist excludes every in-flight status", () => {
    for (const live of ["initiated", "ringing", "in_progress", "answered"]) {
      expect(TERMINAL_CALL_STATUSES).not.toContain(live);
    }
    expect(TERMINAL_CALL_STATUSES).toContain("failed");
  });
});
