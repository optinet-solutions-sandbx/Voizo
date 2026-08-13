// hangupOutcome — PURE mapping from a FreeSWITCH hangup to our call status,
// terminal outcome, and the duration we persist (VOZ-247).
//
// Extracted from src/app/api/webhooks/freeswitch/voice-status/route.ts for the
// same reason smsDispatchDecision was: this decides how EVERY call is counted,
// so it belongs in a unit-testable function rather than inline in the route.
//
// ── The bug this fixes ──────────────────────────────────────────────────────
// The shim used to send FreeSWITCH's `duration`, which is TOTAL channel time —
// it includes ringing. The route then treated `NORMAL_CLEARING && duration > 0`
// as a completed conversation. A phone that rang 25s and was never answered
// clears NORMAL_CLEARING with duration=25, so it was logged as a COMPLETED CALL
// with 25 seconds of "talk time".
//
// Measured on the 2026-07-27/28 realtime run: of 660 calls we called
// "connected", only 210 had ever reached Vapi. The other 450 returned 404 on a
// direct Vapi lookup, had no recording, no transcript and no ended_reason, and
// their durations topped out at 38s — the ring window. Reported answer rate was
// 92%; the real rate was 29.5%. Every one of those also burned a retry attempt.
//
// ── The fix ─────────────────────────────────────────────────────────────────
// `billsec` is answer-to-hangup time (0 when never answered) and `answer_stamp`
// exists only on an answered channel. Either one settles "did a human pick up",
// which `duration` cannot. answer_stamp is preferred because a call answered and
// dropped inside a second can round billsec to 0 while still being a real answer.
//
// Backward compatible ON PURPOSE: the Vercel route and the EC2 shim deploy
// separately, so for a window one runs new code against the other's old payload.
// When neither new field is present we fall back to the legacy duration>0 rule,
// which is exactly today's behavior — so deploy order does not matter.

export type CallStatus = "completed" | "busy" | "no_answer" | "failed" | "canceled";
export type TerminalOutcome = "completed" | "busy" | "no_answer" | "failed" | "canceled";

export interface HangupSignals {
  /** FreeSWITCH `duration`: TOTAL channel seconds, INCLUDING ring. Legacy field. */
  totalSeconds: number;
  /** FreeSWITCH `billsec`: answer→hangup seconds, 0 if never answered. Null when
   *  the shim predates VOZ-247. */
  talkSeconds: number | null;
  /** FreeSWITCH `answer_stamp`: present only on an answered channel. Null/absent
   *  when unanswered OR when the shim predates VOZ-247. */
  answerStamp: string | null;
}

export interface HangupOutcome {
  status: CallStatus;
  terminalOutcome: TerminalOutcome;
  /** What to persist as calls_v2.duration_seconds — talk time when we know it,
   *  else the legacy total. Never the ring window on an unanswered call. */
  durationSeconds: number;
  /** True/false once the shim reports it; null on a legacy payload. Surfaced in
   *  the voice-status log line only — calls_v2 has NO `answered` column today, so
   *  do not query for one. If analytics ever needs the durable tri-state
   *  (answered / not answered / legacy-unknown), that is a small migration plus
   *  one key in the route's updatePayload. */
  answered: boolean | null;
}

/**
 * Did a human (or a machine) actually pick up? Null means the payload carries no
 * answer evidence at all — a legacy shim — and the caller must fall back.
 */
export function resolveAnswered(s: HangupSignals): boolean | null {
  // answer_stamp first: authoritative, and survives a sub-second answer that
  // rounds billsec down to 0.
  if (typeof s.answerStamp === "string" && s.answerStamp.trim().length > 0) return true;
  if (typeof s.talkSeconds === "number") return s.talkSeconds > 0;
  return null; // legacy payload — no answer evidence either way
}

/**
 * Attempt-budget classification (2026-08-05).
 *
 * A player's max_attempts budget must measure chances THE PLAYER had, not
 * dials we fired. Before this, every terminal call burned an attempt — so the
 * 08-02/05 trunk failures (rejects, out-of-funds intercepts) consumed attempt
 * budgets of players whose phone never rang once: 3,823 players measured
 * retired as 'unreached' with ZERO delivered rings.
 *
 *   delivered          — the handset heard about the call (answered, busy, or
 *                        rang out). Burns an attempt. Voicemail is 'completed'
 *                        status, so it lands here — correctly.
 *   transient_failure  — died before ringing anyone (trunk reject, bridge
 *                        failure, our own cancel). FREE retry; the reject
 *                        breaker + the dial ceiling bound the loop.
 *   permanent_failure  — the number itself is dead/invalid. Terminal now:
 *                        retrying an unallocated number forever is the zombie
 *                        leak the no-burn rule would otherwise create.
 */
export type AttemptClass = "delivered" | "transient_failure" | "permanent_failure";

const PERMANENT_CAUSES = new Set([
  "UNALLOCATED_NUMBER",
  "NO_ROUTE_DESTINATION",
  "INVALID_NUMBER_FORMAT",
]);

export function classifyAttempt(hangupCause: string | null, status: CallStatus): AttemptClass {
  const cause = (hangupCause || "").toUpperCase();
  if (PERMANENT_CAUSES.has(cause)) return "permanent_failure";
  if (status === "completed" || status === "busy" || status === "no_answer") return "delivered";
  return "transient_failure"; // 'failed' / 'canceled' — nobody's phone rang
}

/**
 * How many attempts the player has used once THIS hangup is accounted for.
 *
 * 2026-08-05 rework: `burns` (delivered-ness via classifyAttempt) is the single
 * source of truth. The old `wasGhost` dedupe existed because fireCall's catch
 * ALSO counted; that catch no longer touches attempt_count (a provider failure
 * rang nobody), so a ghost-recovered call is simply counted here like any other
 * — iff it was delivered. This keeps VOZ-248's guarantee (one dial can never
 * burn two attempts) while fixing its blind spot (a dial that rang nobody
 * burning one).
 */
export function resolveAttemptCount(args: { current: number | null; burns: boolean }): number {
  const current = args.current ?? 0;
  return args.burns ? current + 1 : current;
}

/**
 * When a call COMPLETES, the player was reached — so the number must not be left
 * queued for a retry that a prior FALSE 'failed' put it in (VOZ-269).
 *
 * The ESL-timeout ghost path: the shim reports failure, FreeSWITCH placed the call
 * anyway, and fireCall's catch marks the row 'failed' AND moves the number to
 * 'pending_retry' (or 'unreached' at max) BEFORE the hangup webhook arrives. VOZ-248
 * then recovers the CALL row to completed — but left that stale number state, so the
 * queued retry still fired ~1h later: 35 of 55 confirmed false-negatives were
 * re-dialled. This override is the missing half of VOZ-248.
 *
 * Returns the outcome a completed call must FORCE the number back to when it is
 * stuck in such a stale state ('in_progress', so Vapi's end-of-call sets the real
 * final outcome exactly as it does for a normal completed call), else null — leave
 * it alone. A normal completed call's number is already 'in_progress' (→ null, no
 * write), and a Vapi-set outcome (sent_sms / not_interested / declined_offer) is
 * never touched (→ null), so a real conversion result can never be lost here.
 */
export function completedNumberOutcomeOverride(currentOutcome: string | null): "in_progress" | null {
  return currentOutcome === "pending_retry" || currentOutcome === "unreached" ? "in_progress" : null;
}

/**
 * Which end-of-call classes PARK the number instead of writing a terminal
 * outcome (2026-08-13)? "Park" = leave outcome at 'in_progress' so the
 * scheduler's stale-in_progress sweeper resolves it to pending_retry and the
 * player is re-dialled (bounded by max_attempts) — the mechanism the voicemail
 * skip (2026-05-11) and the VOZ-127 callback skip already use. Extracted from
 * processEndOfCall's inline conditions so the routing decision is unit-testable
 * (same reason smsDispatchDecision and this module exist).
 *
 * The new class: `silent_pickup` — the line answered but nobody ever spoke.
 * Measured 2026-08-13: all 158 dead-air pickups that day were retired as
 * 'not_interested', a refusal by players who never said a word, while detected
 * VOICEMAILS correctly rode the retry cycle. A machine got a retry; a possibly
 * real human got terminated. This parks them like voicemails.
 *
 * Guard semantics (each preserved verbatim from the inline originals):
 *  - goal/opt-out ALWAYS win — those classes write sent_sms / declined_offer.
 *  - voicemail parks REGARDLESS of dispatch intent: registered_optin texts the
 *    missed-call followup AND retries the number (2026-06-11 design).
 *  - callback and silent_pickup park only when NO opt-in text went out
 *    (registeredDispatchIntent) — a texted player is retired sent_sms, which is
 *    optin_any_pickup's designed behaviour for its silent pickups.
 */
export type OutcomeParkReason = "voicemail" | "callback" | "silent_pickup";

export function decideOutcomePark(args: {
  voicemailDetected: boolean;
  goalReached: boolean;
  optedOut: boolean;
  /** An opt-in-mode SMS is actually going out for this call (mode ≠ verbal_yes
   *  && dispatch decided attempt && SMS configured). */
  registeredDispatchIntent: boolean;
  /** customerRequestedCallback(transcript) — computed by the caller. */
  callbackRequested: boolean;
  /** deriveAttemptTag for this call (the dashboard/dispatch classifier). */
  attemptTag?: string;
}): OutcomeParkReason | null {
  if (args.goalReached || args.optedOut) return null;
  if (args.voicemailDetected) return "voicemail";
  if (args.registeredDispatchIntent) return null;
  if (args.callbackRequested) return "callback";
  if (args.attemptTag === "silent_pickup") return "silent_pickup";
  return null;
}

export function mapHangup(hangupCause: string | null, s: HangupSignals): HangupOutcome {
  const cause = (hangupCause || "").toUpperCase();
  const answered = resolveAnswered(s);
  // Talk time when the shim reports it; otherwise the legacy total. On an
  // unanswered call talkSeconds is 0, which is the honest number — the ring
  // window is not conversation.
  const durationSeconds = typeof s.talkSeconds === "number" ? s.talkSeconds : s.totalSeconds;

  // Unambiguous causes first — they never depend on answer state.
  if (cause === "USER_BUSY") return { status: "busy", terminalOutcome: "busy", durationSeconds, answered };
  if (cause === "NO_ANSWER" || cause === "ALLOTTED_TIMEOUT") {
    return { status: "no_answer", terminalOutcome: "no_answer", durationSeconds, answered };
  }
  if (cause === "ORIGINATOR_CANCEL") {
    return { status: "canceled", terminalOutcome: "canceled", durationSeconds, answered };
  }

  // NORMAL_CLEARING is the ambiguous one: both a real conversation and a
  // spam-filtered/unanswered leg clear "normally". Answer evidence decides it.
  if (cause === "NORMAL_CLEARING") {
    if (answered === true) return { status: "completed", terminalOutcome: "completed", durationSeconds, answered };
    if (answered === false) return { status: "no_answer", terminalOutcome: "no_answer", durationSeconds, answered };
    // Legacy payload: preserve the pre-VOZ-247 rule verbatim so a shim that has
    // not been redeployed yet behaves exactly as it does today.
    return s.totalSeconds > 0
      ? { status: "completed", terminalOutcome: "completed", durationSeconds, answered }
      : { status: "no_answer", terminalOutcome: "no_answer", durationSeconds, answered };
  }

  return { status: "failed", terminalOutcome: "failed", durationSeconds, answered };
}
