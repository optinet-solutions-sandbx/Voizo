import { describe, expect, it } from "vitest";
import { decideLastResortSend, decideSmsDispatch, type SmsDispatchInput } from "./smsDispatchDecision";

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
