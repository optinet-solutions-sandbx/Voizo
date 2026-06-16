import { describe, expect, it } from "vitest";
import { decideSmsDispatch, type SmsDispatchInput } from "./smsDispatchDecision";

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
  it("opt-out and explicit decline still beat the voicemail follow-up", () => {
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, optedOut: true }))
      .toEqual({ attempt: false, reason: "opted_out_on_call" });
    expect(decideSmsDispatch({ ...reg, voicemailDetected: true, customerDeclinedSms: true }))
      .toEqual({ attempt: false, reason: "customer_declined_sms" });
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
