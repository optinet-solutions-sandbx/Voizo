import { describe, expect, it } from "vitest";
import {
  decideLastResortSend,
  decideSmsDispatch,
  parseSmsConsentMode,
  resolveSmsConsentMode,
  SMS_CONSENT_MODES,
  type SmsDispatchInput,
} from "./smsDispatchDecision";

const base: SmsDispatchInput = {
  mode: "verbal_yes",
  goalReached: false,
  nativeSuccess: false,
  voicemailDetected: false,
  optedOut: false,
  hasVerbalConsent: false,
  agentAnnouncedSms: false,
  customerDeclinedSms: false,
  humanConversation: false,
};

// VOZ-245 (Val, 2026-07-28): registered_optin minus the humanConversation gate.
// Every answered line gets the one text; only an on-call "stop calling" or an
// explicit "don't text me" veto it, and detected voicemail keeps its own branch
// so the last-resort setting still governs machines.
describe("decideSmsDispatch — optin_any_pickup (VOZ-245)", () => {
  const anyPickup: SmsDispatchInput = { ...base, mode: "optin_any_pickup" };

  it("texts a pickup where NOBODY SPOKE — the case registered_optin vetoes", () => {
    // 28 such calls in the 07-27/28 run (agent talked 77-118s, zero customer
    // turns). Jasiel/Val chose "treat as reached, text immediately".
    expect(decideSmsDispatch(anyPickup)).toEqual({ attempt: true, reason: "any_pickup_reached" });
    expect(decideSmsDispatch({ ...anyPickup, mode: "registered_optin" }))
      .toEqual({ attempt: false, reason: "no_human_conversation" });
  });

  it("texts a real conversation regardless of quality (no goal, no verbal consent)", () => {
    expect(decideSmsDispatch({ ...anyPickup, humanConversation: true }))
      .toEqual({ attempt: true, reason: "any_pickup_reached" });
  });

  it('an on-call "stop calling" still wins over everything', () => {
    expect(decideSmsDispatch({ ...anyPickup, humanConversation: true, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
    // even on a voicemail pickup
    expect(decideSmsDispatch({ ...anyPickup, voicemailDetected: true, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });

  it('an explicit "don\'t text me" from a live human still vetoes', () => {
    expect(decideSmsDispatch({ ...anyPickup, humanConversation: true, customerDeclinedSms: true }))
      .toEqual({ attempt: false, reason: "customer_declined_sms" });
  });

  it("ORDERING: voicemail is judged BEFORE the decline check", () => {
    // Load-bearing (2026-06-25 fix, re-verified for this mode): the SMS-decline
    // classifier false-positives on machine greetings ("No message can be left
    // on this service..."). Hoisting the decline check above voicemail dropped
    // ~9 of these texts in simulation against the real run.
    expect(decideSmsDispatch({ ...anyPickup, voicemailDetected: true, customerDeclinedSms: true }))
      .toEqual({ attempt: true, reason: "registered_optin_voicemail_followup" });
  });

  it("respects last-resort: a voicemail re-dials instead of texting now", () => {
    expect(decideSmsDispatch({ ...anyPickup, voicemailDetected: true, lastResortMode: true }))
      .toEqual({ attempt: false, reason: "voicemail_redial_first" });
    // ...but a SILENT PICKUP is not a voicemail, so it still texts immediately
    // (that is exactly the fork Jasiel/Val settled).
    expect(decideSmsDispatch({ ...anyPickup, lastResortMode: true }))
      .toEqual({ attempt: true, reason: "any_pickup_reached" });
  });

  it("qualifies for the last-resort text like the other opt-in mode", () => {
    const ok = {
      outcome: "unreached", attemptCount: 3, maxAttempts: 3, smsEnabled: true,
      lastResortTemplate: "Sorry we missed you! ...", campaignStatus: "running",
    };
    expect(decideLastResortSend({ ...ok, mode: "optin_any_pickup" })).toBe(true);
  });
});

describe("parseSmsConsentMode — STRICT, for writes (VOZ-245)", () => {
  it("accepts exactly the four real values", () => {
    for (const m of SMS_CONSENT_MODES) expect(parseSmsConsentMode(m)).toBe(m);
    expect(SMS_CONSENT_MODES).toHaveLength(4); // + optin_reached_only (Val 2026-08-07)
  });

  it("returns null on anything else so the API 400s instead of coercing", () => {
    // The read-side resolver coerces to verbal_yes; a WRITE must not, or an
    // operator's typo would silently narrow dispatch to the strictest policy.
    for (const bad of [null, undefined, "", "  verbal_yes", "VERBAL_YES", "any_pickup", "optin", 7, {}, []]) {
      expect(parseSmsConsentMode(bad)).toBeNull();
    }
  });

  it("read-side and write-side disagree ON PURPOSE for a bad value", () => {
    expect(resolveSmsConsentMode("nonsense")).toBe("verbal_yes"); // safe fallback
    expect(parseSmsConsentMode("nonsense")).toBeNull(); // loud rejection
  });
});

describe("resolveSmsConsentMode — the single place the DB column is interpreted", () => {
  it("maps the three known values", () => {
    expect(resolveSmsConsentMode("verbal_yes")).toBe("verbal_yes");
    expect(resolveSmsConsentMode("registered_optin")).toBe("registered_optin");
    expect(resolveSmsConsentMode("optin_any_pickup")).toBe("optin_any_pickup");
  });

  it("falls back to the MOST-GATED mode on anything unknown", () => {
    // A bad/absent read must never widen dispatch.
    for (const bad of [null, undefined, "", "REGISTERED_OPTIN", "any_pickup", 7, {}]) {
      expect(resolveSmsConsentMode(bad)).toBe("verbal_yes");
    }
  });
});

describe("decideSmsDispatch — verbal_yes (today's behavior preserved)", () => {
  it("sends on goal + genuine verbal consent", () => {
    expect(decideSmsDispatch({ ...base, goalReached: true, hasVerbalConsent: true }))
      .toEqual({ attempt: true, reason: "verbal_consent" });
  });
  it("sends on goal + native success (no transcript consent needed)", () => {
    expect(decideSmsDispatch({ ...base, goalReached: true, nativeSuccess: true }).attempt).toBe(true);
  });
  it("never sends without goal_reached, even with consent in the transcript", () => {
    expect(decideSmsDispatch({ ...base, hasVerbalConsent: true }))
      .toEqual({ attempt: false, reason: "goal_not_reached" });
  });
  it("never sends on goal without consent evidence (the 2026-06-04 gate)", () => {
    expect(decideSmsDispatch({ ...base, goalReached: true }))
      .toEqual({ attempt: false, reason: "no_consent_evidence" });
  });
  it("voicemail vetoes even native success", () => {
    expect(decideSmsDispatch({ ...base, goalReached: true, nativeSuccess: true, voicemailDetected: true }))
      .toEqual({ attempt: false, reason: "voicemail" });
  });
  it("on-call opt-out vetoes even goal + consent", () => {
    expect(decideSmsDispatch({ ...base, goalReached: true, hasVerbalConsent: true, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });
});

describe("decideSmsDispatch — registered_optin (signup opt-in basis; announce no longer required, Val 2026-06-16)", () => {
  const reg: SmsDispatchInput = { ...base, mode: "registered_optin", humanConversation: true };

  it("sends to ANY reached human — the agent need NOT announce (Ernie ticket fix 2026-06-16)", () => {
    expect(decideSmsDispatch(reg)).toEqual({ attempt: true, reason: "registered_optin_reached" });
  });
  it("still sends when the agent DID announce (announce is no longer a gate, just observability)", () => {
    expect(decideSmsDispatch({ ...reg, agentAnnouncedSms: true }))
      .toEqual({ attempt: true, reason: "registered_optin_reached" });
  });
  it("still sends when goal also reached", () => {
    expect(decideSmsDispatch({ ...reg, goalReached: true }).attempt).toBe(true);
  });
  it("an explicit 'don't text me' always wins (compliance veto)", () => {
    expect(decideSmsDispatch({ ...reg, customerDeclinedSms: true }))
      .toEqual({ attempt: false, reason: "customer_declined_sms" });
  });
  it("voicemail pickup TRIGGERS the missed-call follow-up (client-agreed 2026-06-11)", () => {
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, humanConversation: false }))
      .toEqual({ attempt: true, reason: "registered_optin_voicemail_followup" });
  });
  it("on-call opt-out still beats the voicemail follow-up", () => {
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });
  it("voicemail follow-up now WINS over a detected SMS-decline (2026-06-25): the decline classifier false-positives on a 'message bank full' voicemail greeting ('No message can be left on this service…'), which has no live human to genuinely decline — so the follow-up takes precedence (opt-out still wins, above)", () => {
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, customerDeclinedSms: true }))
      .toEqual({ attempt: true, reason: "registered_optin_voicemail_followup" });
  });
  it("no real human conversation still vetoes (review H3: agent monologue into an undetected machine)", () => {
    expect(decideSmsDispatch({ ...reg, humanConversation: false }))
      .toEqual({ attempt: false, reason: "no_human_conversation" });
  });
  it("on-call opt-out still vetoes", () => {
    expect(decideSmsDispatch({ ...reg, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });
});

describe("decideSmsDispatch — last-resort mode (VOZ-132 §8, built 2026-07-10)", () => {
  const reg: SmsDispatchInput = { ...base, mode: "registered_optin", humanConversation: true };

  it("voicemail in last-resort mode re-dials instead of texting instantly", () => {
    expect(
      decideSmsDispatch({ ...reg, voicemailDetected: true, humanConversation: false, lastResortMode: true }),
    ).toEqual({ attempt: false, reason: "voicemail_redial_first" });
  });

  it("lastResortMode absent/false keeps today's instant follow-up byte-for-byte", () => {
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, humanConversation: false }))
      .toEqual({ attempt: true, reason: "registered_optin_voicemail_followup" });
    expect(
      decideSmsDispatch({ ...reg, voicemailDetected: true, humanConversation: false, lastResortMode: false }),
    ).toEqual({ attempt: true, reason: "registered_optin_voicemail_followup" });
  });

  it("a reached human still gets the normal text in last-resort mode (only the voicemail branch changes)", () => {
    expect(decideSmsDispatch({ ...reg, lastResortMode: true }))
      .toEqual({ attempt: true, reason: "registered_optin_reached" });
  });

  it("verbal_yes is untouched by the flag (voicemail still an absolute veto)", () => {
    expect(decideSmsDispatch({ ...base, voicemailDetected: true, lastResortMode: true, goalReached: true, nativeSuccess: true }))
      .toEqual({ attempt: false, reason: "voicemail" });
  });

  it("on-call opt-out still beats everything in last-resort mode", () => {
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, optedOut: true, lastResortMode: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });
});

describe("decideLastResortSend — the one exhaustion text (VOZ-132 §8)", () => {
  const ok = {
    outcome: "unreached",
    attemptCount: 3,
    maxAttempts: 3,
    mode: "registered_optin" as const,
    smsEnabled: true,
    lastResortTemplate: "Sorry we missed you! ...",
    campaignStatus: "running",
  };

  it("sends for a genuinely exhausted unreached player in a live last-resort campaign", () => {
    expect(decideLastResortSend(ok)).toBe(true);
    expect(decideLastResortSend({ ...ok, campaignStatus: "paused" })).toBe(true);
    expect(decideLastResortSend({ ...ok, attemptCount: 5 })).toBe(true);
  });

  it("NEVER sends to realtime-rollover bookkeeping rows (unreached but under max — the player continues in today's child)", () => {
    expect(decideLastResortSend({ ...ok, attemptCount: 2 })).toBe(false);
    expect(decideLastResortSend({ ...ok, attemptCount: null })).toBe(false);
  });

  it("mode 1 (verbal_yes) never sends — no spoken yes means no text, ever", () => {
    expect(decideLastResortSend({ ...ok, mode: "verbal_yes" })).toBe(false);
  });

  it("off without the template / sms disabled / non-unreached / terminal campaign", () => {
    expect(decideLastResortSend({ ...ok, lastResortTemplate: null })).toBe(false);
    expect(decideLastResortSend({ ...ok, lastResortTemplate: "   " })).toBe(false);
    expect(decideLastResortSend({ ...ok, smsEnabled: false })).toBe(false);
    expect(decideLastResortSend({ ...ok, outcome: "pending_retry" })).toBe(false);
    expect(decideLastResortSend({ ...ok, outcome: "sent_sms" })).toBe(false);
    expect(decideLastResortSend({ ...ok, campaignStatus: "completed" })).toBe(false);
    expect(decideLastResortSend({ ...ok, campaignStatus: "inactive" })).toBe(false);
  });
});

// optin_reached_only (Val, 2026-08-07 — relayed by Jasiel): text everyone we
// GENUINELY talk to — even an on-call SMS refusal does not veto (Val's literal
// rule, Jasiel confirmed 2026-08-07 over the promote-emphatic alternative).
// Never text: voicemail, early hang-up (dead-air pickup), agent timeout
// (pipeline died — we owe them a redial, not a text), unreached (and therefore
// no last-resort either). "Stop calling" opt-out still beats everything.
//
// The engagement signal is the DASHBOARD's own attempt tag (deriveAttemptTag),
// so the SMS card's Reached sub-rows and dispatch can never disagree — the
// invariant Val asked for: no SMS may ever appear under the Early hang-up filter.
describe("decideSmsDispatch — optin_reached_only (Val 2026-08-07)", () => {
  const reached: SmsDispatchInput = {
    ...base,
    mode: "optin_reached_only",
    humanConversation: true,
    attemptTag: "neutral",
  };

  it("texts a neutral reached human (no goal, no consent evidence needed)", () => {
    expect(decideSmsDispatch(reached)).toEqual({ attempt: true, reason: "reached_engaged" });
  });

  it("texts a positive (goal reached)", () => {
    expect(decideSmsDispatch({ ...reached, goalReached: true, attemptTag: "positive" }))
      .toEqual({ attempt: true, reason: "reached_engaged" });
  });

  it("texts a declined contact — refusers still get the text (literal Val)", () => {
    expect(decideSmsDispatch({ ...reached, attemptTag: "declined", customerDeclinedSms: true }))
      .toEqual({ attempt: true, reason: "reached_engaged" });
  });

  it("refuses a silent pickup — zero human evidence never gets a text (2026-08-13)", () => {
    // Phase A measured 316 zero-turn calls tagged 'neutral' (= texted) across 12 days
    // because the agent-ended path dodged every early-hangup branch. silent_pickup is
    // its own refused bucket with its own reason, so logs show WHY the text was held.
    expect(decideSmsDispatch({ ...reached, attemptTag: "silent_pickup" }))
      .toEqual({ attempt: false, reason: "silent_pickup" });
  });

  it('an on-call SMS refusal ("don\'t text me") does NOT veto in this mode', () => {
    expect(decideSmsDispatch({ ...reached, customerDeclinedSms: true }))
      .toEqual({ attempt: true, reason: "reached_engaged" });
  });

  it('"stop calling" opt-out still beats everything', () => {
    expect(decideSmsDispatch({ ...reached, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });

  it("voicemail is NEVER texted — even with a last-resort template configured", () => {
    expect(decideSmsDispatch({ ...reached, voicemailDetected: true, humanConversation: false, attemptTag: "voicemail" }))
      .toEqual({ attempt: false, reason: "voicemail" });
    // last-resort must NOT convert this into a deferred text (mode excludes last-resort)
    expect(decideSmsDispatch({ ...reached, voicemailDetected: true, humanConversation: false, attemptTag: "voicemail", lastResortMode: true }))
      .toEqual({ attempt: false, reason: "voicemail" });
  });

  it("early hang-up is never texted — the dashboard-filter invariant", () => {
    expect(decideSmsDispatch({ ...reached, humanConversation: false, attemptTag: "early_hangup" }))
      .toEqual({ attempt: false, reason: "early_hangup" });
  });

  it("agent timeout (pipeline death on a live pickup) is never texted", () => {
    expect(decideSmsDispatch({ ...reached, attemptTag: "agent_timeout" }))
      .toEqual({ attempt: false, reason: "agent_timeout" });
  });

  it("a missing attempt tag fails SAFE: no text", () => {
    expect(decideSmsDispatch({ ...reached, attemptTag: undefined }).attempt).toBe(false);
  });

  it("unreachable tag never texts", () => {
    expect(decideSmsDispatch({ ...reached, attemptTag: "unreachable" }).attempt).toBe(false);
  });

  it("does NOT qualify for the last-resort text (Val: never text unreached)", () => {
    const ok = {
      outcome: "unreached", attemptCount: 3, maxAttempts: 3, smsEnabled: true,
      lastResortTemplate: "Sorry we missed you! ...", campaignStatus: "running",
    };
    expect(decideLastResortSend({ ...ok, mode: "optin_reached_only" })).toBe(false);
  });

  it("resolver + validator accept the new mode; unknowns still coerce to verbal_yes", () => {
    expect(resolveSmsConsentMode("optin_reached_only")).toBe("optin_reached_only");
    expect(parseSmsConsentMode("optin_reached_only")).toBe("optin_reached_only");
    expect(SMS_CONSENT_MODES).toContain("optin_reached_only");
    expect(resolveSmsConsentMode("optin_reached_onlyX")).toBe("verbal_yes");
  });
});

// 2026-08-27: a voicemail must never be texted in optin_reached_only, whatever the tag
// says. deriveAttemptTag lets goal_reached beat voicemail (a DISPLAY rule, Val 2026-07-03),
// and Vapi's success analysis has read machine greetings as a yes: nine texts went to a
// machine that said only "Message.", four to "...will send the message as a text". The
// webhook pre-empts this by dropping goal_reached on a voicemail, so the case below cannot
// reach the function from production today — the test pins the invariant INSIDE the
// function so it survives a caller that forgets the ordering.
describe("decideSmsDispatch — optin_reached_only never texts a voicemail, even a 'positive' one (2026-08-27)", () => {
  const goalOnVoicemail: SmsDispatchInput = {
    mode: "optin_reached_only",
    goalReached: true,
    nativeSuccess: true,
    voicemailDetected: true,
    optedOut: false,
    hasVerbalConsent: false,
    agentAnnouncedSms: false,
    customerDeclinedSms: false,
    humanConversation: false,
    attemptTag: "positive",
  };
  it("refuses a voicemail that carries goal_reached=true and a 'positive' tag", () => {
    expect(decideSmsDispatch(goalOnVoicemail)).toEqual({ attempt: false, reason: "voicemail" });
  });
  it("refuses it under every textable tag, not only 'positive'", () => {
    for (const attemptTag of ["neutral", "declined"] as const) {
      expect(decideSmsDispatch({ ...goalOnVoicemail, attemptTag }), attemptTag).toEqual({ attempt: false, reason: "voicemail" });
    }
  });
  it("the same call WITHOUT the voicemail flag is still texted — the guard is voicemail-only", () => {
    expect(decideSmsDispatch({ ...goalOnVoicemail, voicemailDetected: false }))
      .toEqual({ attempt: true, reason: "reached_engaged" });
  });
  it("'stop calling' still outranks it (reason stays opted_out_on_call)", () => {
    expect(decideSmsDispatch({ ...goalOnVoicemail, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
  });
});
