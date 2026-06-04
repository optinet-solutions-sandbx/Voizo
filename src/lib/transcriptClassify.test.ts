import { describe, it, expect } from "vitest";
import { isVoicemail, hasRealConversation, hasGenuineCustomerConsent } from "./transcriptClassify";

// Real AU "message bank" voicemails the filter MISSED (campaign 9df71cd3, 2026-06-03).
// These were surfaced as fake "real conversations" in /reviews — the bug this test pins.
const AU_VOICEMAILS = {
  messageBankFull:
    "AI: Hi. It's Tom from Lucky seven Casino. I saw you register an account with us recently. Does this sound familiar?\nUser: This message bank is full. Please try again later. Goodbye.",
  messageBankWithDigits:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Seven three seven three. This message bank is full. Please try again later. Goodbye.",
  finishedRecording:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: When you have finished recording, you may hang up.\nAI: Goodbye. Goodbye",
  leaveMessageAfterTone:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Please leave a detailed message after the tone. When you have finished recording, you may hang up, or press one for more options.\nAI: Goodbye.",
};

// A classic (pre-existing) voicemail that already tripped the >=2 generic patterns — must STAY voicemail.
const CLASSIC_VOICEMAIL =
  "AI: Hi, it's Tom.\nUser: You've reached the voicemail of John. Please leave a message after the beep.";

// A GENUINE customer conversation (the labeled good call) — must STAY a real conversation (regression guard).
const GENUINE =
  "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Yes.\nAI: Great. You've got twenty free spins. Can I send the details via SMS?\nUser: Yes. Send me the details. How do I activate them?\nAI: Just log in and activate. I'll send the SMS now.\nUser: Wonderful. Thank you so much. Do I need to deposit any funds?\nAI: Completely free. I've sent the SMS.\nUser: Cheers. Will do. Thank you.";

// A real customer brush-off that contains ONE weak phrase — must NOT be flagged voicemail.
const REAL_BRUSHOFF =
  "AI: Hi, it's Tom from Lucky seven.\nUser: I'm not available to talk right now, call me some other time.";

describe("isVoicemail — AU 'message bank' coverage (the fix)", () => {
  it("flags 'this message bank is full' voicemails", () => {
    expect(isVoicemail(AU_VOICEMAILS.messageBankFull)).toBe(true);
    expect(isVoicemail(AU_VOICEMAILS.messageBankWithDigits)).toBe(true);
  });
  it("flags 'when you have finished recording' voicemails", () => {
    expect(isVoicemail(AU_VOICEMAILS.finishedRecording)).toBe(true);
  });
  it("flags 'please leave a detailed message after the tone' voicemails", () => {
    expect(isVoicemail(AU_VOICEMAILS.leaveMessageAfterTone)).toBe(true);
  });
  it("still flags classic >=2-pattern voicemails", () => {
    expect(isVoicemail(CLASSIC_VOICEMAIL)).toBe(true);
  });
});

describe("isVoicemail — no false positives", () => {
  it("does NOT flag a genuine conversation", () => {
    expect(isVoicemail(GENUINE)).toBe(false);
  });
  it("does NOT flag a real customer brush-off with a single weak phrase", () => {
    expect(isVoicemail(REAL_BRUSHOFF)).toBe(false);
  });
  it("does NOT flag empty input", () => {
    expect(isVoicemail("")).toBe(false);
  });
});

describe("hasRealConversation — AU voicemails are excluded, genuine stays", () => {
  it("excludes the AU message-bank voicemails (the /reviews bug)", () => {
    for (const t of Object.values(AU_VOICEMAILS)) expect(hasRealConversation(t)).toBe(false);
  });
  it("keeps the genuine conversation", () => {
    expect(hasRealConversation(GENUINE)).toBe(true);
  });
  it("keeps a real customer brush-off (they did talk)", () => {
    expect(hasRealConversation(REAL_BRUSHOFF)).toBe(true);
  });
});

describe("isVoicemail — extended machine coverage (2026-06-04)", () => {
  it("catches voice mailbox / messaging / answering system", () => {
    expect(isVoicemail("Please leave a message for the voice mailbox of John.")).toBe(true);
    expect(isVoicemail("You have reached the automated voice messaging system.")).toBe(true);
    expect(isVoicemail("Your call has been forwarded to an automated answering service.")).toBe(true);
  });
  it("catches mailbox-full / unable-to-take-your-call", () => {
    expect(isVoicemail("The mailbox is full. Goodbye.")).toBe(true);
    expect(isVoicemail("We are not able to take your call right now.")).toBe(true);
  });
  it("catches IVR via two weak signals", () => {
    expect(isVoicemail("Please hold. For sales press two, for support press three.")).toBe(true);
  });
  it("no false positive on a genuine human reply", () => {
    expect(isVoicemail("Yeah sure, go ahead and send it.")).toBe(false);
    expect(isVoicemail("No thanks, not interested.")).toBe(false);
  });
});

describe("hasGenuineCustomerConsent (2026-06-04)", () => {
  const offer = "AI: Can I send you the details via SMS?";
  it("true on a real post-offer assent (incl. STT-truncated 'Y.')", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Yes, please.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Go ahead.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Sounds good.`)).toBe(true);
    expect(hasGenuineCustomerConsent("AI: I'll send the details to this number.\nUser: Okay.")).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Y.`)).toBe(true);
    expect(hasGenuineCustomerConsent(GENUINE)).toBe(true);
  });
  it("FALSE on the live-bug voicemail fragments", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Message.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: A message.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Seven four five four.`)).toBe(false);
  });
  it("FALSE on machine text that LOOKS substantive (the probe leak)", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Please leave a detailed message after the tone.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Your call has been forwarded to an automated voice messaging system.`)).toBe(false);
  });
  it("FALSE on agent-only line with no customer assent (the live bug)", () => {
    expect(hasGenuineCustomerConsent("AI: I'll send you an SMS now.\nUser: Message.")).toBe(false);
  });
  it("FALSE on label-less transcript (conservative)", () => {
    expect(hasGenuineCustomerConsent("yeah sure send it")).toBe(false);
  });
  it("FALSE on the AU machine-bank voicemails", () => {
    for (const t of Object.values(AU_VOICEMAILS)) expect(hasGenuineCustomerConsent(t)).toBe(false);
  });
  it("respects negation in the assent turn", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: No, don't.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Nah, leave it.`)).toBe(false);
  });
});
