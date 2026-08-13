import { describe, expect, it } from "vitest";
import {
  classifyAttempt,
  completedNumberOutcomeOverride,
  decideOutcomePark,
  mapHangup,
  resolveAnswered,
  resolveAttemptCount,
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
