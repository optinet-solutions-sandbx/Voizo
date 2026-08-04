// src/lib/scheduler/rejectBreaker.ts
//
// VOZ-278 circuit breaker: a campaign whose recent calls are ALL CALL_REJECTED
// is dialing a dead/blocked caller ID (carrier spam flag, trunk refusal). Every
// further dial burns ANI reputation and player attempts for zero value — the
// 08-02/03 incident hammered 31k rejects into one number's reputation.
//
// The scheduler checks this once per running campaign per tick and, on trip,
// atomically pauses the campaign + posts a Slack alert (operator decision per
// 2026-08-04: alert + auto-pause; un-pausing is the operator's explicit act).
//
// Streak is evaluated over calls from the LAST 30 MINUTES ONLY: after an
// operator fixes the CID and resumes, the pre-fix rejects age out instead of
// instantly re-tripping the breaker on a now-healthy campaign. If the CID is
// still blocked, fresh rejects re-trip it within minutes — which is correct.

export const REJECT_BREAKER_STREAK = 15;
export const REJECT_BREAKER_WINDOW_MINUTES = 30;

/**
 * True when the first REJECT_BREAKER_STREAK entries (callers pass causes
 * NEWEST-FIRST) are all CALL_REJECTED. Fewer entries than the streak → false.
 * A null cause (in-flight/unknown) breaks the streak defensively.
 */
export function isRejectStreak(
  causes: ReadonlyArray<string | null>,
  streak: number = REJECT_BREAKER_STREAK,
): boolean {
  if (causes.length < streak) return false;
  return causes.slice(0, streak).every((c) => c === "CALL_REJECTED");
}
