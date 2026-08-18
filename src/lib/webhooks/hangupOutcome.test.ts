import { describe, expect, it } from "vitest";
import {
  classifyAttempt,
  completedNumberOutcomeOverride,
  decideOutcomePark,
  hasRouteRefusalStreak,
  isRouteRefusal,
  mapHangup,
  nextRetryDelayMs,
  resolveAnswered,
  resolveAttemptCount,
  ROUTE_REFUSAL_DEFER_HOURS,
  ROUTE_REFUSAL_STREAK_LIMIT,
  type HangupSignals,
} from "./hangupOutcome";

// Legacy payload = what a not-yet-redeployed shim sends: total duration only.
const legacy = (totalSeconds: number): HangupSignals => ({
  totalSeconds,
  talkSeconds: null,
  answerStamp: null,
});
// New payload = post-VOZ-247 shim.
const modern = (
  totalSeconds: number,
  talkSeconds: number,
  answerStamp: string | null = null,
): HangupSignals => ({ totalSeconds, talkSeconds, answerStamp });

describe("mapHangup — the 450-phantom-calls bug (VOZ-247)", () => {
  it("a call that RANG 25s and was never answered is no_answer, not completed", () => {
    // The exact prod signature: NORMAL_CLEARING, 25s of ring, billsec 0.
    // Before VOZ-247 this was logged 'completed' with 25s of "talk time".
    const r = mapHangup("NORMAL_CLEARING", modern(25, 0));
    expect(r.status).toBe("no_answer");
    expect(r.terminalOutcome).toBe("no_answer");
    expect(r.durationSeconds).toBe(0); // ring time is NOT talk time
    expect(r.answered).toBe(false);
  });

  it("the whole observed ring window (1-38s) never counts as a conversation", () => {
    // 450 real rows sat in this band, all mislabelled 'completed'.
    for (const ring of [1, 11, 20, 21, 25, 31, 38]) {
      const r = mapHangup("NORMAL_CLEARING", modern(ring, 0));
      expect(r.status).toBe("no_answer");
      expect(r.durationSeconds).toBe(0);
    }
  });

  it("a REAL conversation still counts, and records TALK time not total time", () => {
    // Answered after 6s of ring, then 93s of talking (the real median).
    const r = mapHangup("NORMAL_CLEARING", modern(99, 93));
    expect(r.status).toBe("completed");
    expect(r.terminalOutcome).toBe("completed");
    expect(r.durationSeconds).toBe(93); // not 99 — ring is excluded
    expect(r.answered).toBe(true);
  });

  it("an answer that drops inside a second still counts (answer_stamp beats billsec=0)", () => {
    // Pickup-and-hangup: billsec rounds to 0 but the channel WAS answered.
    const r = mapHangup("NORMAL_CLEARING", modern(9, 0, "2026-07-28 10:15:03"));
    expect(r.answered).toBe(true);
    expect(r.status).toBe("completed");
  });
});

describe("mapHangup — backward compatibility during the split deploy", () => {
  // Vercel and the EC2 shim deploy separately, so for a window the new route
  // runs against the old payload. That MUST behave exactly as it does today.
  it("legacy payload keeps the pre-VOZ-247 rule verbatim", () => {
    expect(mapHangup("NORMAL_CLEARING", legacy(25)).status).toBe("completed"); // old behavior
    expect(mapHangup("NORMAL_CLEARING", legacy(0)).status).toBe("no_answer");
    expect(mapHangup("NORMAL_CLEARING", legacy(93)).durationSeconds).toBe(93);
  });

  it("legacy payload reports answered=null — 'we cannot tell', not 'no'", () => {
    expect(mapHangup("NORMAL_CLEARING", legacy(25)).answered).toBeNull();
    expect(resolveAnswered(legacy(25))).toBeNull();
  });

  it("so deploy order does not matter in either direction", () => {
    // new shim + old route is untestable here (old route ignores the fields),
    // but new route + old shim is the risky half and it is pinned above.
    expect(mapHangup("NORMAL_CLEARING", modern(25, 0)).status).toBe("no_answer");
    expect(mapHangup("NORMAL_CLEARING", legacy(25)).status).toBe("completed");
  });
});

describe("mapHangup — unambiguous causes are unchanged", () => {
  it("busy / no_answer / canceled / failed ignore answer state", () => {
    expect(mapHangup("USER_BUSY", modern(3, 0)).status).toBe("busy");
    expect(mapHangup("NO_ANSWER", modern(30, 0)).status).toBe("no_answer");
    expect(mapHangup("ALLOTTED_TIMEOUT", modern(30, 0)).status).toBe("no_answer");
    expect(mapHangup("ORIGINATOR_CANCEL", modern(2, 0)).status).toBe("canceled");
    expect(mapHangup("CALL_REJECTED", modern(1, 0)).status).toBe("failed");
    expect(mapHangup("UNALLOCATED_NUMBER", modern(1, 0)).status).toBe("failed");
    expect(mapHangup(null, modern(1, 0)).status).toBe("failed");
  });

  it("is case-insensitive on the cause, like before", () => {
    expect(mapHangup("normal_clearing", modern(99, 93)).status).toBe("completed");
    expect(mapHangup("user_busy", modern(3, 0)).status).toBe("busy");
  });

  it("a BUSY that somehow reports talk time still persists that talk time", () => {
    expect(mapHangup("USER_BUSY", modern(5, 4)).durationSeconds).toBe(4);
  });
});

describe("classifyAttempt — only calls the player could hear burn attempt budget (2026-08-05)", () => {
  it("delivered: answered, busy, and rang-out calls burn an attempt", () => {
    expect(classifyAttempt("NORMAL_CLEARING", "completed")).toBe("delivered");
    expect(classifyAttempt("USER_BUSY", "busy")).toBe("delivered");
    expect(classifyAttempt("NO_ANSWER", "no_answer")).toBe("delivered");
    // Voicemail calls map to status 'completed' (a machine answered) — they
    // legitimately consumed a chance to reach the player.
    expect(classifyAttempt("NORMAL_CLEARING", "completed")).toBe("delivered");
  });

  it("transient: trunk rejects and bridge failures rang NOBODY — free retry", () => {
    // The 08-02/05 signature: out-of-funds intercepts / trunk blocks. These
    // consumed the attempt budgets of 3,823 players whose phone never rang.
    expect(classifyAttempt("CALL_REJECTED", "failed")).toBe("transient_failure");
    // Our own bridge-fail cause (dialplan tail, 2026-08-05 EC2 deploy).
    expect(classifyAttempt("NORMAL_TEMPORARY_FAILURE", "failed")).toBe("transient_failure");
    // We hung up before it rang — our doing, not the player's missed chance.
    expect(classifyAttempt("ORIGINATOR_CANCEL", "canceled")).toBe("transient_failure");
    // Unknown/garbage causes default to transient (never silently burn).
    expect(classifyAttempt(null, "failed")).toBe("transient_failure");
    expect(classifyAttempt("SOME_NEW_CAUSE", "failed")).toBe("transient_failure");
  });

  it("permanent: dead/invalid numbers terminalize instead of retrying forever", () => {
    expect(classifyAttempt("UNALLOCATED_NUMBER", "failed")).toBe("permanent_failure");
    expect(classifyAttempt("NO_ROUTE_DESTINATION", "failed")).toBe("permanent_failure");
    expect(classifyAttempt("INVALID_NUMBER_FORMAT", "failed")).toBe("permanent_failure");
    // Case-insensitive on the raw cause string.
    expect(classifyAttempt("unallocated_number", "failed")).toBe("permanent_failure");
  });
});

describe("resolveAttemptCount — delivered-ness is the single source of truth (2026-08-05)", () => {
  it("a delivered call burns exactly one attempt", () => {
    expect(resolveAttemptCount({ current: 0, burns: true })).toBe(1);
    expect(resolveAttemptCount({ current: 2, burns: true })).toBe(3);
    expect(resolveAttemptCount({ current: null, burns: true })).toBe(1);
  });

  it("a call that rang nobody holds the count — the VOZ-248 guarantee, generalized", () => {
    // One dial can never burn two attempts (old wasGhost dedupe), AND a dial
    // that rang nobody can no longer burn one (the old rule's blind spot).
    expect(resolveAttemptCount({ current: 1, burns: false })).toBe(1);
    expect(resolveAttemptCount({ current: 3, burns: false })).toBe(3);
    expect(resolveAttemptCount({ current: null, burns: false })).toBe(0);
  });

  it("a player at cap stays at cap through a non-burning failure (retires on time, not early)", () => {
    const maxAttempts = 3;
    const afterFailure = resolveAttemptCount({ current: 3, burns: false });
    expect(afterFailure).toBe(3);
    expect(afterFailure >= maxAttempts).toBe(true);
  });
});

describe("completedNumberOutcomeOverride — a completed call must not leave a stale retry (VOZ-269)", () => {
  it("a ghost recovered to completed clears the stale pending_retry the catch set", () => {
    // ESL-timeout: fireCall's catch marked the row failed AND queued the number
    // for retry, THEN the hangup webhook recovered the call to completed. Without
    // this override the number stays pending_retry and re-dials ~1h later
    // (35 of 55 confirmed double-dials).
    expect(completedNumberOutcomeOverride("pending_retry")).toBe("in_progress");
  });

  it("a ghost that had hit max (outcome unreached) is corrected too — the player WAS reached", () => {
    expect(completedNumberOutcomeOverride("unreached")).toBe("in_progress");
  });

  it("a NORMAL completed call (number already in_progress) is left untouched", () => {
    // The non-ghost path: the number is 'in_progress' and Vapi's end-of-call
    // sets the real final outcome. Overriding here would be a pointless write.
    expect(completedNumberOutcomeOverride("in_progress")).toBeNull();
  });

  it("never overrides a Vapi-set outcome — those win regardless", () => {
    // The caller already guards these, but the pure rule must not lose a real
    // conversion result if it were ever reached with one.
    expect(completedNumberOutcomeOverride("sent_sms")).toBeNull();
    expect(completedNumberOutcomeOverride("not_interested")).toBeNull();
    expect(completedNumberOutcomeOverride("declined_offer")).toBeNull();
  });

  it("null / unknown outcome is left as-is", () => {
    expect(completedNumberOutcomeOverride(null)).toBeNull();
    expect(completedNumberOutcomeOverride("suppressed")).toBeNull();
  });
});

describe("resolveAnswered", () => {
  it("answer_stamp wins when present", () => {
    expect(resolveAnswered(modern(10, 0, "2026-07-28 10:15:03"))).toBe(true);
  });
  it("blank/whitespace answer_stamp is not evidence", () => {
    expect(resolveAnswered(modern(10, 0, "   "))).toBe(false); // falls through to billsec
    expect(resolveAnswered({ totalSeconds: 10, talkSeconds: null, answerStamp: "" })).toBeNull();
  });
  it("billsec decides when there is no stamp", () => {
    expect(resolveAnswered(modern(10, 0))).toBe(false);
    expect(resolveAnswered(modern(10, 1))).toBe(true);
  });
});

// ── decideOutcomePark (2026-08-13): which end-of-call classes PARK the number ──
// at in_progress (sweeper → pending_retry → re-dial) instead of writing a
// terminal outcome. Measured motivation: on 2026-08-13 all 158 dead-air pickups
// were retired as 'not_interested' — a refusal by players who never said a word —
// while detected voicemails correctly rode the retry cycle.
describe("decideOutcomePark — silent pickups ride the retry cycle", () => {
  const base = {
    voicemailDetected: false,
    goalReached: false,
    optedOut: false,
    registeredDispatchIntent: false,
    callbackRequested: false,
    attemptTag: "neutral" as const,
  };

  it("parks a silent pickup for retry (was: terminal not_interested)", () => {
    expect(decideOutcomePark({ ...base, attemptTag: "silent_pickup" })).toBe("silent_pickup");
  });
  it("does NOT park a silent pickup an opt-in mode actually texted (sent_sms retirement stands)", () => {
    // optin_any_pickup texts every answered line by design — its silent pickups
    // are retired as sent_sms, exactly as before.
    expect(decideOutcomePark({ ...base, attemptTag: "silent_pickup", registeredDispatchIntent: true })).toBeNull();
  });
  it("goal and opt-out always win over the silent park", () => {
    expect(decideOutcomePark({ ...base, attemptTag: "silent_pickup", goalReached: true })).toBeNull();
    expect(decideOutcomePark({ ...base, attemptTag: "silent_pickup", optedOut: true })).toBeNull();
  });
  it("pins the existing voicemail park — INCLUDING when a followup text goes out", () => {
    // registered_optin voicemail: text the missed-call followup AND retry the number
    // (2026-05-11 + 06-11 design) — the voicemail park deliberately ignores dispatch intent.
    expect(decideOutcomePark({ ...base, voicemailDetected: true })).toBe("voicemail");
    expect(decideOutcomePark({ ...base, voicemailDetected: true, registeredDispatchIntent: true })).toBe("voicemail");
    expect(decideOutcomePark({ ...base, voicemailDetected: true, goalReached: true })).toBeNull();
    expect(decideOutcomePark({ ...base, voicemailDetected: true, optedOut: true })).toBeNull();
  });
  it("pins the existing callback park (VOZ-127) and its dispatch-intent guard", () => {
    expect(decideOutcomePark({ ...base, callbackRequested: true })).toBe("callback");
    expect(decideOutcomePark({ ...base, callbackRequested: true, registeredDispatchIntent: true })).toBeNull();
  });
  it("voicemail outranks callback and silent when several apply", () => {
    expect(decideOutcomePark({ ...base, voicemailDetected: true, callbackRequested: true, attemptTag: "silent_pickup" }))
      .toBe("voicemail");
  });
  it("an ordinary reached call parks nothing (terminal outcome writes as before)", () => {
    expect(decideOutcomePark(base)).toBeNull();
  });
});

// ── Route-refusal streak (2026-08-18 SquareTalk AU-landline SIP-500) ─────────
//
// The outage: SquareTalk's AU geographic route began answering our INVITEs with
// SIP 500 overnight 08-17 -> 08-18; AU mobiles were untouched. A refusal is a
// `transient_failure` (correctly — nobody's phone rang), so it burns no attempt
// and the number is re-queued every retry_interval_minutes. Measured on 08-18:
// 150 landlines consumed 456 dials, and the whole window went on numbers that
// had already proven unroutable while mobiles connecting at 86% waited.
//
// These predicates stop RE-DIALLING such a number for the rest of the day. They
// deliberately do NOT touch attempt accounting — see the regression block below.

describe("isRouteRefusal — only a carrier 5xx on the outbound leg counts", () => {
  it("recognises the 08-18 refusal (SIP 500 / NORMAL_TEMPORARY_FAILURE / recv_refuse)", () => {
    expect(isRouteRefusal("500")).toBe(true);
  });
  it("recognises the other carrier 5xx, so the NEXT route failure is contained too", () => {
    expect(isRouteRefusal("502")).toBe(true);
    expect(isRouteRefusal("503")).toBe(true);
    expect(isRouteRefusal("504")).toBe(true);
  });
  it("does NOT count destination-state replies — those reached the handset and burn attempts", () => {
    // Measured 08-13..08-18: 480/486/404/403/484/487 also arrive as recv_refuse,
    // but map to no_answer -> 'delivered'. They describe the PHONE, not a broken
    // route, and suppressing on them would silently cut reach.
    for (const s of ["200", "480", "486", "404", "403", "484", "487"]) {
      expect(isRouteRefusal(s)).toBe(false);
    }
  });
  it("does NOT count 6xx global refusals — platform-wide is the reject breaker's job", () => {
    // 603 was the 08-05..08-12 out-of-funds outage: EVERY number gets refused, so
    // per-number suppression is the wrong lever and would defer a whole roster.
    for (const s of ["600", "603", "608"]) expect(isRouteRefusal(s)).toBe(false);
  });
  it("an absent SIP status fails OPEN (never suppresses) — the shim may omit it", () => {
    // SIP capture is only 40-73% of dials and is failure-biased; a missing status
    // must leave dialling exactly as it is today, never suppress on a guess.
    expect(isRouteRefusal(null)).toBe(false);
    expect(isRouteRefusal(undefined)).toBe(false);
    expect(isRouteRefusal("")).toBe(false);
    expect(isRouteRefusal("   ")).toBe(false);
    expect(isRouteRefusal("5")).toBe(false);
    expect(isRouteRefusal("5xx")).toBe(false);
  });
});

describe("hasRouteRefusalStreak — consecutive refusals on ONE number, newest first", () => {
  const r = (s: string | null) => ({ sip_term_status: s });
  it(`trips at ${ROUTE_REFUSAL_STREAK_LIMIT} consecutive refusals`, () => {
    expect(hasRouteRefusalStreak([r("500"), r("500")])).toBe(true);
  });
  it("does NOT trip on a single refusal — one blip is not a broken route", () => {
    // 08-14 (healthy day) still produced 6 numbers with two refusals in a row, so
    // the threshold is chosen from the streak distribution, not from one failure.
    expect(hasRouteRefusalStreak([r("500")])).toBe(false);
    expect(hasRouteRefusalStreak([r("500"), r("200")])).toBe(false);
  });
  it("resets the moment the newest dial is not a refusal (the route came back)", () => {
    expect(hasRouteRefusalStreak([r("200"), r("500"), r("500")])).toBe(false);
    expect(hasRouteRefusalStreak([r("480"), r("500"), r("500")])).toBe(false);
  });
  it("looks only at the newest dials — older history cannot un-trip it", () => {
    expect(hasRouteRefusalStreak([r("500"), r("500"), r("200"), r("200")])).toBe(true);
  });
  it("never trips on a number with no dial history", () => {
    expect(hasRouteRefusalStreak([])).toBe(false);
  });
  it("fails OPEN when the newest dial has no SIP status recorded", () => {
    expect(hasRouteRefusalStreak([r(null), r("500")])).toBe(false);
  });
});

describe("nextRetryDelayMs — the streak moves WHEN we dial next, nothing else", () => {
  it("uses the campaign's own retry interval when there is no streak", () => {
    expect(nextRetryDelayMs({ retryMinutes: 30, routeRefusalStreak: false })).toBe(30 * 60 * 1000);
    expect(nextRetryDelayMs({ retryMinutes: 90, routeRefusalStreak: false })).toBe(90 * 60 * 1000);
  });
  it("defers past the end of today's window once the streak trips", () => {
    expect(nextRetryDelayMs({ retryMinutes: 30, routeRefusalStreak: true })).toBe(
      ROUTE_REFUSAL_DEFER_HOURS * 60 * 60 * 1000,
    );
  });
  it("the deferral clears one call window, never more", () => {
    // Windows are one per day (VOZ-360) and ~4.5h long; the AU window runs
    // 05:00-09:30Z. A 12h deferral from ANY moment inside it lands after today's
    // close (17:00-21:30Z) and before tomorrow's 05:00Z open, so the number is
    // dialable again on the next window with no human action.
    const AU_WINDOW_HOURS = 4.5;
    expect(ROUTE_REFUSAL_DEFER_HOURS).toBeGreaterThan(AU_WINDOW_HOURS);
    expect(ROUTE_REFUSAL_DEFER_HOURS).toBeLessThan(24 - AU_WINDOW_HOURS);
  });
  it("never shortens a retry — a streak can only push the next dial later", () => {
    for (const retryMinutes of [5, 30, 90, 240, 1440]) {
      expect(nextRetryDelayMs({ retryMinutes, routeRefusalStreak: true })).toBeGreaterThanOrEqual(
        nextRetryDelayMs({ retryMinutes, routeRefusalStreak: false }),
      );
    }
  });
});

// ── The regression that would matter most ───────────────────────────────────
//
// The OBVIOUS fix for the retry amplifier is to make a repeated 500 burn an
// attempt. That re-creates the 08-02/05 incidents exactly: 3,823 players were
// retired whose phone never rang once, because trunk-level failures counted
// against max_attempts. Suppression and attempt accounting are two different
// levers and only the first one moves here.
describe("route-refusal suppression must NOT re-create the 3,823-player incident", () => {
  const r = (s: string | null) => ({ sip_term_status: s });
  const burnsFor = (cause: string, status: "failed") =>
    classifyAttempt(cause, status) === "delivered";

  it("a single trunk refusal still does NOT burn an attempt", () => {
    expect(classifyAttempt("NORMAL_TEMPORARY_FAILURE", "failed")).toBe("transient_failure");
    expect(
      resolveAttemptCount({ current: 2, burns: burnsFor("NORMAL_TEMPORARY_FAILURE", "failed") }),
    ).toBe(2);
  });

  it("a refusal does not burn an attempt EVEN WHEN the streak has tripped", () => {
    expect(hasRouteRefusalStreak([r("500"), r("500")])).toBe(true);
    // Same classification, same count: the streak only changes next_attempt_at.
    expect(classifyAttempt("NORMAL_TEMPORARY_FAILURE", "failed")).toBe("transient_failure");
    expect(
      resolveAttemptCount({ current: 2, burns: burnsFor("NORMAL_TEMPORARY_FAILURE", "failed") }),
    ).toBe(2);
  });

  it("no run of refusals, however long, ever reaches max_attempts", () => {
    let count = 0;
    for (let i = 0; i < 20; i++) {
      count = resolveAttemptCount({
        current: count,
        burns: burnsFor("NORMAL_TEMPORARY_FAILURE", "failed"),
      });
    }
    expect(count).toBe(0); // 20 refused dials, zero attempts spent
  });

  it("a refusal is still not a PERMANENT failure — nothing terminal is written", () => {
    // permanent_failure is the one class that writes outcome:'unreached' straight
    // away. A 500 must never land there: SquareTalk will fix the route.
    expect(classifyAttempt("NORMAL_TEMPORARY_FAILURE", "failed")).not.toBe("permanent_failure");
  });
});
