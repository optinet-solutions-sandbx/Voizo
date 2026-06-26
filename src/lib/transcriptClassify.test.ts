import { describe, it, expect } from "vitest";
import {
  isVoicemail, hasRealConversation, hasGenuineCustomerConsent,
  agentMentionedSms, customerDeclinedSms, substantiveUserTurnCount,
} from "./transcriptClassify";

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

// ── #4 (2026-06-08): machines isVoicemail MISSED — caused /reviews contamination + (pre-patch)
// false goal_reached. Verified machine answers from the labeled L7_AU_VOIZO set (28/05–05/06).
const MISSED_MACHINES = {
  carrierDivert:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Point number eight zero one to send a text, hang up before the tone, and you won't be charged. Standard call charges apply if you proceed. Your number four four two zero will be sent in a text message to the person you called. If you wish to leave an alternative number, please press the hash key.\nAI: Goodbye.",
  voicemailToText:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: phone and will send the message as a text.\nAI: Perfect. I'll send you an SMS now.\nUser: Your voice message is being converted to text and will be sent as an SMS. Goodbye.",
  ivrCallback:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: We'll get straight back to you. Please let us know your phone number.\nAI: Goodbye.",
  bareMessage:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Message.\nAI: Sure. I'll send the details to this number now.",
  yourMessage:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Your message.\nAI: Yes. I'm calling regarding your recent sign up.",
  messageIsText:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: The message is a text.\nAI: Goodbye.",
  spelledDigits:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Seven four five four.\nAI: Hi. It's Tom from Lucky seven Casino.",
  spelledDigitsTwo:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: One zero.\nAI: Sorry. I didn't quite catch that.",
};

// Genuine humans from the SAME labeled set (wrong-number / decline). MUST stay visible.
const REAL_HUMANS = {
  wrongNumber:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: No. That's not actually. sure we got the right number?\nAI: Thanks for letting me know.",
  deleteAccount:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: No. Can you, like, delete my account? That's not me.\nAI: I'm really sorry about that.\nUser: Thank you.",
};

describe("isVoicemail — fragment/digit/divert machines (#4, 2026-06-08)", () => {
  it("flags carrier voicemail-to-text divert announcements", () => {
    expect(isVoicemail(MISSED_MACHINES.carrierDivert)).toBe(true);
    expect(isVoicemail(MISSED_MACHINES.voicemailToText)).toBe(true);
  });
  it("flags the IVR callback greeting (we'll-get-back + number, combined)", () => {
    expect(isVoicemail(MISSED_MACHINES.ivrCallback)).toBe(true);
  });
  it("flags bare voicemail-to-text fragments (whole user turn)", () => {
    expect(isVoicemail(MISSED_MACHINES.bareMessage)).toBe(true);
    expect(isVoicemail(MISSED_MACHINES.yourMessage)).toBe(true);
    expect(isVoicemail(MISSED_MACHINES.messageIsText)).toBe(true);
  });
  it("flags spelled-out-digit-only user turns (>=2 tokens)", () => {
    expect(isVoicemail(MISSED_MACHINES.spelledDigits)).toBe(true);
    expect(isVoicemail(MISSED_MACHINES.spelledDigitsTwo)).toBe(true);
  });
});

describe("isVoicemail — #4 must NOT silence real humans", () => {
  it("keeps the verified wrong-number / decline humans visible", () => {
    expect(isVoicemail(REAL_HUMANS.wrongNumber)).toBe(false);
    expect(isVoicemail(REAL_HUMANS.deleteAccount)).toBe(false);
  });
  it("does not flag a lone interjection or single number-word", () => {
    expect(isVoicemail("AI: Hi.\nUser: Oh.")).toBe(false);
    expect(isVoicemail("AI: Hi.\nUser: One.")).toBe(false);
  });
  it("does not flag a human who also says a number mid-conversation", () => {
    expect(isVoicemail("AI: Can I send the SMS?\nUser: Yeah, my number ends four five five six.\nUser: Go ahead.")).toBe(false);
  });
  it("excludes the #4 machines from /reviews but keeps real humans", () => {
    for (const t of Object.values(MISSED_MACHINES)) expect(hasRealConversation(t)).toBe(false);
    expect(hasRealConversation(REAL_HUMANS.wrongNumber)).toBe(true);
    expect(hasRealConversation(REAL_HUMANS.deleteAccount)).toBe(true);
  });
});

// ── #5 (2026-06-08): machine "hold / leave-a-message / IVR" greetings hasRealConversation
// MISSED — surfaced in /reviews (campaign L7_CA_..._05/06) + slipped into golden set v1
// (the judge abstained on them). Fixed in hasRealConversation ONLY; the call-path isVoicemail
// (webhook goal veto + consent gate) is left byte-for-byte unchanged.
const MISSED_MACHINES_5 = {
  stayOnLine:
    "AI: Hi. It's Tom from Lucky seven Casino. I saw you register an account with us recently. Does this sound familiar?\nUser: Thanks. Please stay on the line.\nAI: Goodbye. Goodbye.",
  recordYourMessage:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Record your message.\nAI: Goodbye.",
  noMoreRoom:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: Sorry, but there's no more room to record messages. Please hang up and try again later. Bye.",
  hangUpPressPound:
    "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?\nUser: You can hang up or press pound for more options.\nAI: Goodbye.",
};

// A REAL engaged customer who uses a hold phrase but ALSO says real things — turn-aware FP guard.
const REAL_WITH_HOLD =
  "AI: Can I send you the details via SMS?\nUser: Yes, but please stay on the line while I grab a pen.\nUser: Okay, go ahead and send it.";

describe("hasRealConversation — #5 machine greetings (stay-on-line / record-message / IVR)", () => {
  it("excludes the new machine greetings from /reviews + freeze", () => {
    for (const t of Object.values(MISSED_MACHINES_5)) expect(hasRealConversation(t)).toBe(false);
  });
  it("keeps a real customer who uses a hold phrase but also engages (turn-aware FP guard)", () => {
    expect(hasRealConversation(REAL_WITH_HOLD)).toBe(true);
  });
  it("leaves the call-path isVoicemail unchanged (these stay isVoicemail=false; webhook untouched)", () => {
    for (const t of Object.values(MISSED_MACHINES_5)) expect(isVoicemail(t)).toBe(false);
  });
  it("still keeps the verified real humans + genuine conversation + brush-off visible", () => {
    expect(hasRealConversation(REAL_HUMANS.wrongNumber)).toBe(true);
    expect(hasRealConversation(GENUINE)).toBe(true);
    expect(hasRealConversation(REAL_BRUSHOFF)).toBe(true);
  });
});

// ── Ernie ticket (2026-06-16): AU/CA carrier voicemail greetings isVoicemail MISSED, so they
// fell through to the live-human path, hit the registered_optin announce gate, and got no SMS —
// when they should have been missed-call follow-ups. Real transcripts from L7_AU/CA_STEVIC 15–16/06.
const CARRIER_VOICEMAILS = {
  audioMessage:
    "AI: Hey. Victor here from Lucky seven dot com. Quick question. Have you had a chance to log in recently?\nUser: The person you are calling is not available. Please leave a short message, and it will be sent as an audio message.\nAI: Goodbye. Goodbye.",
  audioMessageGarbled:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: Both of you are calling is not available. Please leave a short message, and it will be sent as an audio message.\nAI: Goodbye.",
  recordYourName:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: If you record your name and reason for calling, I'll see if this person is available.\nAI: Goodbye.",
  voiceMessageSystem:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: has been forwarded to an automatic voice message system.\nAI: Goodbye. Goodbye.",
  mailboxNumber:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: You have reached mailbox number zero four five two one three four zero three seven.\nAI: Goodbye.",
  cannotComeToPhone:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: Unfortunately, the person that you called cannot come to the phone at the moment. This is the butler speaking. If you'd like me to, I can pass on a message for you.\nAI: Goodbye.",
  missedYourCall:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: Sorry I missed your call. Please leave a message.\nAI: Goodbye.",
  leaveNameAndNumber:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: Hi. You've reached Tiffany. You know what to do. Leave your name and number so I can get back to you.\nAI: Goodbye.",
  unavailableLeaveMessage:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: Hi. I'm unavailable right now. Leave me a message, and I will call you back.\nAI: Goodbye.",
};

// Genuine human pickups from the SAME campaigns — MUST stay non-voicemail (the FP guard that makes
// this a delicate fix, not a blunt one). Mostly minimal "Hello?" answers where the pitch was cut
// off — a real person still answered.
const CARRIER_REAL_HUMANS = {
  bareHello:
    "AI: Hey. Victor here from Lucky seven dot com. Quick question. Have you had a chance to log in to your account recently?\nUser: Hello?",
  engagedHuman:
    "AI: Hey, uh, Victor here from Lucky seven dot com. Quick question. Have you had a chance to log in to your account recently?\nUser: Hello? Hi. No. Why is that? No. I haven't. Sorry.\nAI: He...",
  helloFromLondon:
    "AI: Hey. Victor here from Lucky seven dot com.\nUser: Hello from London. Yo.\nUser: Hey, oh, gee. I'm good. Thanks, fellas.",
};

describe("isVoicemail — AU/CA carrier greetings (Ernie ticket, 2026-06-16)", () => {
  it("flags the 'sent as an audio message' carrier greeting (the dominant AU miss)", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.audioMessage)).toBe(true);
    expect(isVoicemail(CARRIER_VOICEMAILS.audioMessageGarbled)).toBe(true);
  });
  it("flags the 'record your name and reason for calling' receptionist greeting", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.recordYourName)).toBe(true);
  });
  it("flags 'automatic voice message system'", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.voiceMessageSystem)).toBe(true);
  });
  it("flags 'you have reached mailbox number' (full-form, not just the contraction)", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.mailboxNumber)).toBe(true);
  });
  it("flags 'cannot come to the phone' greetings", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.cannotComeToPhone)).toBe(true);
  });
  it("flags 'sorry I missed your call, please leave a message'", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.missedYourCall)).toBe(true);
  });
  it("flags 'leave your name and number' personal greetings", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.leaveNameAndNumber)).toBe(true);
  });
  it("flags 'I'm unavailable right now, leave me a message'", () => {
    expect(isVoicemail(CARRIER_VOICEMAILS.unavailableLeaveMessage)).toBe(true);
  });
});

describe("isVoicemail — carrier-greeting fix must NOT silence real humans", () => {
  it("keeps minimal 'Hello?' pickups and engaged humans as non-voicemail", () => {
    for (const t of Object.values(CARRIER_REAL_HUMANS)) expect(isVoicemail(t)).toBe(false);
  });
  it("keeps those real humans visible in /reviews", () => {
    for (const t of Object.values(CARRIER_REAL_HUMANS)) expect(hasRealConversation(t)).toBe(true);
  });
  it("excludes the carrier voicemails from /reviews", () => {
    for (const t of Object.values(CARRIER_VOICEMAILS)) expect(hasRealConversation(t)).toBe(false);
  });
});

// ── SMS dispatch signals (2026-06-11, registered_optin mode) ────────────────

describe("agentMentionedSms (AI announce detector)", () => {
  it("detects the agent's announce/confirm phrasings", () => {
    expect(agentMentionedSms("AI: I'll send you an SMS now.\nUser: Okay.")).toBe(true);
    expect(agentMentionedSms("AI: I'm sending all of it over SMS right now.\nUser: Bye.")).toBe(true);
    expect(agentMentionedSms("AI: Would it be okay if I text you the details?\nUser: Hmm.")).toBe(true);
  });
  it("ignores customer turns — a customer asking for a text is not an agent announce", () => {
    expect(agentMentionedSms("AI: Hi, it's Tom.\nUser: Just text me the details.")).toBe(false);
  });
  it("catches channel-certain paraphrases (review H2)", () => {
    expect(agentMentionedSms("AI: I'll text you, is that okay?\nUser: Sure.")).toBe(true);
    expect(agentMentionedSms("AI: I'll shoot you a text shortly.\nUser: Okay.")).toBe(true);
    expect(agentMentionedSms("AI: I'll text it over to you.\nUser: Thanks.")).toBe(true);
  });
  it("does NOT arm on non-SMS sends (review H1)", () => {
    expect(agentMentionedSms("AI: I'll send you an email with the details.\nUser: Okay.")).toBe(false);
    expect(agentMentionedSms("AI: We'll send a confirmation email with your bonus details.\nUser: Fine.")).toBe(false);
    expect(agentMentionedSms("AI: I'll send your details over to our team.\nUser: Alright.")).toBe(false);
  });
  it("is conservative on label-less transcripts and no-SMS calls", () => {
    expect(agentMentionedSms("I'll send you an SMS now.")).toBe(false);
    expect(agentMentionedSms("AI: Hi, do you have thirty seconds?\nUser: No.")).toBe(false);
    expect(agentMentionedSms(null)).toBe(false);
  });
});

describe("customerDeclinedSms (explicit text-directed refusal)", () => {
  it("catches explicit refusals of the text", () => {
    expect(customerDeclinedSms("AI: I'll send you an SMS now.\nUser: Please don't text me.")).toBe(true);
    expect(customerDeclinedSms("AI: I'll text you the link.\nUser: No SMS, thanks.")).toBe(true);
    expect(customerDeclinedSms("AI: I'll send the details.\nUser: No need to send anything.")).toBe(true);
    expect(customerDeclinedSms("AI: Sending it over.\nUser: Stop sending me messages.")).toBe(true);
    expect(customerDeclinedSms("AI: I'll text you.\nUser: No more texts please.")).toBe(true);
    expect(customerDeclinedSms("AI: I'll text you.\nUser: I'd rather you didn't text me.")).toBe(true);
  });
  it("does NOT veto acceptance phrasings that contain a negation (review M3)", () => {
    expect(customerDeclinedSms("AI: I'll send it by SMS.\nUser: Don't worry about sending it, text is fine.")).toBe(false);
  });
  it("does NOT veto on voicemail-greeting phrasings (missed-call follow-up must survive)", () => {
    expect(customerDeclinedSms("AI: Hi, it's Tom.\nUser: Don't forget to leave a message after the beep.")).toBe(false);
  });
  it("NEVER fires on grant-idioms or a generic offer-decline", () => {
    expect(customerDeclinedSms("AI: Would it be okay if I text you?\nUser: Yeah, no worries.")).toBe(false);
    expect(customerDeclinedSms("AI: Would it be okay if I text you?\nUser: No problem at all.")).toBe(false);
    expect(customerDeclinedSms("AI: Would it be okay if I text you?\nUser: I don't mind the text.")).toBe(false);
    expect(customerDeclinedSms("AI: Do you have thirty seconds?\nUser: No.")).toBe(false);
    expect(customerDeclinedSms("AI: Interested in the bonus?\nUser: Not interested, goodbye.")).toBe(false);
  });
  it("ignores AI turns and label-less transcripts", () => {
    expect(customerDeclinedSms("AI: Don't worry, I won't text you twice.\nUser: Okay.")).toBe(false);
    expect(customerDeclinedSms("don't text me")).toBe(false);
    expect(customerDeclinedSms(null)).toBe(false);
  });
});

describe("substantiveUserTurnCount", () => {
  it("returns 0 for empty/absent transcript", () => {
    expect(substantiveUserTurnCount("")).toBe(0);
    expect(substantiveUserTurnCount(null)).toBe(0);
    expect(substantiveUserTurnCount(undefined)).toBe(0);
  });
  it("counts only substantive user turns (>=2 chars), not AI turns", () => {
    // attempt-2 real data (+61474932636): one user turn ("Hello?") then the AI talks
    expect(substantiveUserTurnCount("User: Hello?\nAI: Hey. Victor here from Lucky seven dot com.")).toBe(1);
  });
  it("counts multiple real user turns", () => {
    expect(substantiveUserTurnCount("AI: Hi\nUser: yes go on\nAI: great\nUser: not interested")).toBe(2);
  });
  it("ignores a 1-char user turn", () => {
    expect(substantiveUserTurnCount("User: y")).toBe(0);
  });
});
