// src/lib/scheduler/rejectBreaker.ts
//
// VOZ-278 circuit breaker: a campaign whose recent calls ALL fail is burning ANI
// reputation and player attempts for zero value — the 08-02/03 incident hammered
// 31k rejects into one number's reputation.
//
// The scheduler checks this once per running campaign per tick and, on trip,
// atomically pauses the campaign + posts a Slack alert (operator decision per
// 2026-08-04: alert + auto-pause; un-pausing is the operator's explicit act).
//
// Streak is evaluated over calls from the LAST 30 MINUTES ONLY: after an
// operator fixes the CID and resumes, the pre-fix failures age out instead of
// instantly re-tripping the breaker on a now-healthy campaign. If the CID is
// still blocked, fresh failures re-trip it within minutes — which is correct.
//
// ── VOZ-369: why this keys on STATUS, not hangup_cause ──────────────────────
// It used to require 15 consecutive hangup_cause = 'CALL_REJECTED', over a query
// that also filtered `hangup_cause IS NOT NULL`. But fireCall's provider-failure
// catch DELIBERATELY leaves hangup_cause NULL (dialer.ts, so VOZ-248 ghost
// recovery can still self-identify the row) — so every dial that failed BEFORE
// reaching the carrier was excluded from the breaker's view twice over, and the
// breaker could not trip no matter how many there were.
//
// Measured 2026-08-12: 2,027 consecutive originate failures across four
// campaigns, 100% failing before FreeSWITCH, ZERO breaker trips — it ran at
// 3.8 dials/min for a full day. Replayed against those rows, the status-keyed
// predicate below trips ~14 minutes in on all four (2,027 dials → ~60).
//
// `status` is the right key because mapHangup routes BOTH classes to 'failed':
// a carrier reject (CALL_REJECTED falls through to the default branch) and an
// originate failure (fireCall's catch writes status:'failed' directly). Normal
// business outcomes never land there — USER_BUSY → 'busy', NO_ANSWER and an
// unanswered NORMAL_CLEARING → 'no_answer', ORIGINATOR_CANCEL → 'canceled'.
// Replayed over 2026-08-11's real carrier refusals the verdict is IDENTICAL to
// the old predicate (3/9/34/5 trips), and over 2026-08-13's healthy 759 dials
// the longest failure run was 1 of the 15 required.

import type { CallStatus } from "@/lib/webhooks/hangupOutcome";

export const REJECT_BREAKER_STREAK = 15;
export const REJECT_BREAKER_WINDOW_MINUTES = 30;

/**
 * Statuses a call can hold once it is OVER. The caller filters on this so that
 * in-flight rows ('initiated' / 'ringing' / 'in_progress' / 'answered') cannot
 * enter the streak — a call that has not finished is not evidence of anything.
 *
 * An ALLOWLIST on purpose: if CallStatus ever gains a member and it is not added
 * here, those rows are simply excluded, which SHORTENS the streak and makes the
 * breaker trip less. A denylist of in-flight statuses would fail the other way.
 */
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
];

/**
 * True when the first REJECT_BREAKER_STREAK entries (callers pass statuses
 * NEWEST-FIRST, terminal rows only) are all 'failed'. Fewer entries than the
 * streak → false. A null status (unknown) breaks the streak defensively.
 */
export function isFailureStreak(
  statuses: ReadonlyArray<string | null>,
  streak: number = REJECT_BREAKER_STREAK,
): boolean {
  if (statuses.length < streak) return false;
  return statuses.slice(0, streak).every((s) => s === "failed");
}
