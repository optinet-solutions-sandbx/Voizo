import { describe, expect, it } from "vitest";
import { mapHangup, resolveAnswered, resolveAttemptCount, type HangupSignals } from "./hangupOutcome";

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

describe("resolveAttemptCount — ghost calls must not burn two attempts (VOZ-248)", () => {
  it("normal call: voice-status owns the increment", () => {
    expect(resolveAttemptCount({ current: 0, wasGhost: false })).toBe(1);
    expect(resolveAttemptCount({ current: 2, wasGhost: false })).toBe(3);
    expect(resolveAttemptCount({ current: null, wasGhost: false })).toBe(1);
  });

  it("recovered ghost: fireCall's catch ALREADY counted it, so hold the number", () => {
    // Double-counting here would retire the player at 2 real dials on a
    // max_attempts=3 campaign — invisible except as "we stopped calling early".
    expect(resolveAttemptCount({ current: 1, wasGhost: true })).toBe(1);
    expect(resolveAttemptCount({ current: 3, wasGhost: true })).toBe(3);
  });

  it("a ghost never pushes the player OVER the operator's cap by itself", () => {
    const maxAttempts = 3;
    // 2 real dials so far, third dial ghosted (fireCall counted it -> 3).
    const afterGhost = resolveAttemptCount({ current: 3, wasGhost: true });
    expect(afterGhost).toBe(3);
    expect(afterGhost >= maxAttempts).toBe(true); // retires exactly on time, not early
    // Same player, had the call NOT ghosted: also 3. Behaviour is identical.
    expect(resolveAttemptCount({ current: 2, wasGhost: false })).toBe(3);
  });

  it("null current is treated as 0 in both modes", () => {
    expect(resolveAttemptCount({ current: null, wasGhost: true })).toBe(0);
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
