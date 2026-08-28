import { describe, it, expect } from "vitest";
import {
  isVoicemail, isConclusiveVoicemail, hasRealConversation, hasGenuineCustomerConsent,
  agentMentionedSms, customerDeclinedSms, substantiveUserTurnCount, customerRequestedCallback,
  customerRiskDisclosure, type RiskDisclosureCategory,
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

// VOZ-245 (2026-07-28): the lexicon was widened in ONE direction after measuring
// 134 real offers. It already counted 65%; the rejections were mostly correct
// (declines, garbled STT, undetected machines). The genuine misses were all
// explicit send-instructions plus the STT "k" — and the AU grant-idiom, which a
// bare "no" was vetoing. Net effect on real traffic: 65% -> 67%.
describe("hasGenuineCustomerConsent — send-instructions + AU idioms (VOZ-245)", () => {
  const offer = "AI: Can I send you the details via SMS?";

  it("counts an explicit instruction to send — stronger consent than 'okay'", () => {
    // All observed verbatim in real calls and previously thrown away.
    expect(hasGenuineCustomerConsent(`${offer}\nUser: You can send me an SMS.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Send it over.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Send me the link.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Please do.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: You could text me.`)).toBe(true);
  });

  it("counts the STT-collapsed 'k' (sibling of the existing bare 'Y.')", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: k.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Right. k. Thank you.`)).toBe(true);
  });

  it("the name 'Kay' is NOT consent (code-review regression, 2026-07-28)", () => {
    // The first cut used `o?k(?:ay)?`, which also matches the bare word "kay" —
    // so a customer introducing themselves registered as agreeing to the text.
    // `k` must be its own alternative: \b after it rejects "kay" (k→a is not a
    // word boundary) while "k." / "ok" / "okay" keep matching.
    for (const reply of ["This is Kay.", "Kay speaking.", "Hi, Kay here.", "My name is Kay"]) {
      expect(hasGenuineCustomerConsent(`${offer}\nUser: ${reply}`)).toBe(false);
    }
    // and the intended matches still hold
    expect(hasGenuineCustomerConsent(`${offer}\nUser: OK then`)).toBe(true);
  });

  it("counts AU grant-idioms that a bare 'no' used to veto", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Yeah no worries.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: No worries.`)).toBe(true);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: No problem.`)).toBe(true);
  });

  it("STILL refuses 'yeah nah' — an AU REFUSAL that looks like an idiom", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Yeah nah.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Nah you're right.`)).toBe(false);
  });

  it("STILL refuses the mirror-image send phrasing (negation is checked first)", () => {
    expect(hasGenuineCustomerConsent(`${offer}\nUser: You don't have to send the SMS.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Please don't send it.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Do not text me.`)).toBe(false);
  });

  it("STILL refuses real declines that happen to be polite", () => {
    // Measured: gratitude appears on BOTH sides, so it can never be a consent
    // signal on its own. These are the actual decline wordings from prod.
    expect(hasGenuineCustomerConsent(`${offer}\nUser: No. Thank you.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: I'm good. Thank you.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: No thanks.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Not too keen, mate.`)).toBe(false);
  });

  it("STILL refuses gratitude and backchannel alone", () => {
    for (const reply of ["Thank you.", "Thanks", "Cheers", "Mm-hmm", "Uh-huh", "Whatever", "I guess"]) {
      expect(hasGenuineCustomerConsent(`${offer}\nUser: ${reply}`)).toBe(false);
    }
  });

  it("STILL refuses machine greetings that mention sending a message", () => {
    // The widened send-instruction pattern must not read carrier boilerplate as
    // a customer instruction — isVoicemail screens the turn first.
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Your message will be sent as a text message to the person you called.`)).toBe(false);
    expect(hasGenuineCustomerConsent(`${offer}\nUser: Please record your message after the beep.`)).toBe(false);
    for (const t of Object.values(MISSED_MACHINES)) expect(hasGenuineCustomerConsent(t)).toBe(false);
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
    // ...and 2026-08-13's screener rule must not label them voicemail either: the
    // hold phrase is embedded in a genuine turn, so the every-turn rule never fires.
    expect(isVoicemail(REAL_WITH_HOLD)).toBe(false);
  });
  it("call-path isVoicemail: stay-on-the-line (2026-08-13), hang-up-or-press (2026-08-27), record-message + no-more-room (2026-08-28) all label voicemail", () => {
    // The 2026-06-08 version of this test pinned ALL of these to isVoicemail=false,
    // reasoning the SMS gate was protected by hasGenuineCustomerConsent. That became
    // false on 2026-08-07 when optin_reached_only made the label itself the dispatch
    // trigger — 21 of these exact screener pickups were texted on 2026-08-13. The
    // screener script is now conclusive for the LABEL (never the kill path).
    expect(isVoicemail(MISSED_MACHINES_5.stayOnLine)).toBe(true);
    // 2026-08-27 (fix C): the 08-13 version kept press-pound / for-more-options
    // eval-only as "not measured leaking texts" and "too generic". Both premises
    // were then measured false: 8 texts went to "press hash for more options"
    // 18-23 Aug, and written with the IVR grammar on either side of the phrase
    // the shapes flipped 244 prod transcripts with zero real humans among them.
    expect(isVoicemail(MISSED_MACHINES_5.hangUpPressPound)).toBe(true);
    // 2026-08-28: the last two premises fell the same way. Over all 21,847 prod
    // transcripts "record your message" was 358 currently-HUMAN calls (39 texted)
    // and "no more room to record" 26 (5 texted) — see VOICEMAIL_GAP_0828 below.
    expect(isVoicemail(MISSED_MACHINES_5.recordYourMessage)).toBe(true);
    expect(isVoicemail(MISSED_MACHINES_5.noMoreRoom)).toBe(true);
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

// ── 2026-08-13: screener scripts + STT fragments (the 'Neutral' SMS leak) ───
// Every fixture below is a REAL production transcript from 2026-08-13 (trimmed).
// 27 of that day's 53 SMS went to these shapes: the voicemail label missed them,
// so deriveAttemptTag called them 'neutral' and optin_reached_only texted them.

const OPENER =
  "AI: Hey, Victor here from fortune play dot com. Quick question. Have you had a chance to log in to your account recently?";

const SCREENER_LEAKS = {
  // Telstra/handset screener — 21 identical pickups on 2026-08-13, all texted.
  stayOnTheLine: `${OPENER}\nUser: Thanks. Please stay on the line.\nAI: Goodbye.`,
  // STT split the same script into TWO user turns — defeats every-turn rules,
  // must still be caught by the substring pattern.
  stayOnTheLineSplitTurns: `${OPENER}\nUser: Thanks.\nUser: Please stay on the line.\nAI: Goodbye. Goodbye.`,
  // Google/Samsung call screen (leading words are STT debris of "you've reached...").
  sayWhoYouAre: `${OPENER}\nUser: To reach Please say who you are and why you're calling.\nAI: It's Victor calling from Fortune Play Casino.`,
  // Carrier announce — not even a phone that rang.
  numberNotRecognized: `${OPENER}\nUser: The number you have dialed has not been recognized. Please check and try again.`,
  // Personal greeting, STT-garbled ("can't come to the phone" -> "can't be cool").
  // Caught by the weak PAIR: "leave your name" + "a short message".
  garbledGreeting: `${OPENER}\nUser: Can't be cool right now. Please leave your name, number, and a short message, and I'll get back to you.`,
  // Weak PAIR: "leave a message" + "get back to you".
  leaveAMessageGetBack: `${OPENER}\nUser: business that I know. Um, just leave a message, and I'll get back to you.\nAI: Goodbye.`,
  // The voicemail greeting that faked a goal_reached and was texted as 'positive'.
  leaveNameGetBack: `${OPENER}\nUser: Please leave your name and number, and I'll get back to you as soon as I can. okay.\nUser: Thanks.\nAI: Goodbye.`,
};

const FRAGMENT_LEAKS = {
  // Tail fragment of "...will be sent as an audio message" — the entire user turn
  // on 51 calls on 2026-08-13, all surfacing as fake 'early hang-up' humans.
  asAnAudioMessage: `${OPENER}\nUser: As an audio message.\nAI: Goodbye.`,
  anAudioMessage: `${OPENER}\nUser: An audio message.\nAI: Goodbye.`,
  bareAudioMessage: `${OPENER}\nUser: audio message.\nAI: Goodbye.`,
};

// Real humans from the same day who MUST stay human — including the ones that
// share vocabulary with the new patterns.
const SCREENER_REAL_HUMANS = {
  engagedSkeptic: `${OPENER}\nUser: Zero. What?\nAI: Got it. It's Victor calling from Fortune Play Casino.\nUser: I'm rich.\nAI: Have you got a second for me to tell you what it is?\nUser: Yeah. Yeah. No. No. No.`,
  confusedPickup: `${OPENER}\nUser: Nine.\nAI: Got it. The reason I'm calling is I was just going over your account.\nUser: Hello?\nAI: and there's just a bit more sitting on top of that too.\nUser: Thanks,\nAI: Goodbye.`,
  // Single weak fragment alone — a live brush-off must NOT trip the >=2 rule.
  liveBrushOff: `${OPENER}\nUser: Look I'm busy, get back to you later okay?\nAI: No worries.`,
  quickNo: `${OPENER}\nUser: Hello? No.\nAI: Got it.\nUser: Not interested thanks.`,
  // "audio message" fragment next to a genuine turn — every-turn guard must hold.
  audioMessagePlusHuman: `${OPENER}\nUser: An audio message.\nUser: Hello? Sorry, who's this?\nAI: It's Victor from Fortune Play.`,
};

describe("isVoicemail — screener scripts + STT fragments (2026-08-13 SMS leak)", () => {
  it("flags every leaked screener/greeting shape from the 2026-08-13 traffic", () => {
    for (const [name, t] of Object.entries(SCREENER_LEAKS)) {
      expect(isVoicemail(t), name).toBe(true);
    }
  });
  it("flags the bare 'audio message' STT fragment when it is the whole conversation", () => {
    for (const [name, t] of Object.entries(FRAGMENT_LEAKS)) {
      expect(isVoicemail(t), name).toBe(true);
    }
  });
  it("keeps every same-day real human as non-voicemail", () => {
    for (const [name, t] of Object.entries(SCREENER_REAL_HUMANS)) {
      expect(isVoicemail(t), name).toBe(false);
    }
  });
  it("NEVER feeds the mid-call kill path: screener lines are label-only", () => {
    // A live human can sit behind a screener (475 measured 2026-08-07), so the
    // kill tier must not hang up on these — the label re-dials them instead.
    expect(isConclusiveVoicemail("Thanks. Please stay on the line.")).toBe(false);
    expect(isConclusiveVoicemail("Please say who you are and why you're calling.")).toBe(false);
    expect(isConclusiveVoicemail("As an audio message.")).toBe(false);
  });

  // Phase A replay (8,140 prod calls, 07-25..08-13): 39 carrier greetings said
  // "After LEAVING a message..." — the gerund dodges the 'leave a message' weak
  // pattern, so the whole "press pound for more options" family read as humans.
  it("flags the 'after leaving a message ... press pound' carrier family (weak pair)", () => {
    expect(isVoicemail(`${OPENER}\nUser: After leaving a message, you can hang up, or press pound for more options.\nAI: Goodbye.`)).toBe(true);
  });
  it("a lone 'leaving a message' from a live human never trips the >=2 rule", () => {
    expect(isVoicemail(`${OPENER}\nUser: Sorry I was just leaving a message for my doctor — what's this about?\nAI: It's Victor from Fortune Play.`)).toBe(false);
  });
});

// ── 2026-08-14 (VOZ-388): the screener script TRUNCATED mid-phrase ──────────
// Real production shape: the agent talks over the screener, so STT cuts the
// script at "Please stay on" — the whole-phrase rule missed it and +61430221843
// was TEXTED on 08-14 (08-13 twin +61434168825, caught in audit, not texted).
// The complete phrase caught 42 screeners the same day; this is the ~1/day tail.

const TRUNCATED_SCREENERS = {
  // +61430221843, 2026-08-14 (texted). Trailing AI turn was STT debris of "Goodbye".
  stayOnSplit: `${OPENER}\nUser: Thanks.\nUser: Please stay on\nAI: Goodbye.`,
  // +61434168825, 2026-08-13 — same truncation, lowercase.
  stayOnLower: `${OPENER}\nUser: Thanks.\nUser: please stay on\nAI: Goodbye.`,
  // Cut one word later — same family, same rule.
  stayOnThe: `${OPENER}\nUser: Thanks. Please stay on the\nAI: Goodbye.`,
};

const TRUNCATED_GUARDS = {
  // A human continuing past the phrase must stay human — the rule is whole-turn
  // anchored, so ANY tail defeats it.
  stayOnThePhone: `${OPENER}\nUser: Please stay on the phone, I'll get him.\nAI: Sure.`,
  // The June guard re-pinned against the widened regex: hold phrase embedded in
  // a genuine multi-part turn.
  grabAPen: `${OPENER}\nUser: Yes, but please stay on the line while I grab a pen.\nUser: Okay, go ahead.`,
};

describe("isVoicemail — truncated screener script (2026-08-14, VOZ-388)", () => {
  it("catches STT-truncated 'Please stay on' when it is the whole conversation", () => {
    for (const [name, t] of Object.entries(TRUNCATED_SCREENERS)) {
      expect(isVoicemail(t), name).toBe(true);
    }
  });
  it("keeps humans who continue past the phrase", () => {
    for (const [name, t] of Object.entries(TRUNCATED_GUARDS)) {
      expect(isVoicemail(t), name).toBe(false);
    }
  });
  it("stays label-only — never the kill path", () => {
    expect(isConclusiveVoicemail("Thanks. Please stay on")).toBe(false);
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

// ── customerRequestedCallback — callback-request lexicon (VOZ-127, 2026-07-15) ──
// A reached human asking to be called back later routes to pending_retry instead of the
// terminal not_interested. User turns only; opt-out ("don't call me again") and
// customer-is-caller ("I'll call you") framings must NEVER read as a callback.
describe("customerRequestedCallback — routes callback asks to retry", () => {
  const offer = "AI: Have you had a chance to log in recently?";
  it("true on explicit call-me-later / call-me-back asks", () => {
    expect(customerRequestedCallback(`${offer}\nUser: Can you call me tomorrow?`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Can you ring me this afternoon?`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: I'm busy, call later.`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Call me back.`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Call me some other time.`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Give me a call later on.`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Phone me tonight, I'm at work.`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Ring me back next week.`)).toBe(true);
    expect(customerRequestedCallback(`${offer}\nUser: Call me in an hour.`)).toBe(true);
    // "call me …" is unambiguous even when the turn also says "I'll" (the caller-guard
    // only gates the bare "call later" shape, never an explicit "call me").
    expect(customerRequestedCallback(`${offer}\nUser: I'll be out this morning, so call me later.`)).toBe(true);
    // the REAL_BRUSHOFF fixture is exactly a callback ask
    expect(customerRequestedCallback(REAL_BRUSHOFF)).toBe(true);
  });

  it("FALSE on opt-out / DNC framing (must stay not_interested / suppressed)", () => {
    expect(customerRequestedCallback(`${offer}\nUser: Don't call me again.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: Stop calling me.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: Never call this number again.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: No need to call, take me off your list.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: Don't ever call back.`)).toBe(false);
  });

  it("FALSE on plain not-interested with no callback ask", () => {
    expect(customerRequestedCallback(`${offer}\nUser: No thanks, not interested. Goodbye.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: I'm not interested at all.`)).toBe(false);
  });

  it("FALSE when the CUSTOMER offers to call US (not a re-dial request)", () => {
    expect(customerRequestedCallback(`${offer}\nUser: I'll call you later.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: Let me call you back sometime.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: I'll call you back tomorrow.`)).toBe(false);
  });

  it("FALSE on incidental / past-tense / third-party 'call' mentions", () => {
    expect(customerRequestedCallback(`${offer}\nUser: You called me earlier today.`)).toBe(false);
    expect(customerRequestedCallback(`${offer}\nUser: Call the office, not my mobile.`)).toBe(false);
    expect(customerRequestedCallback(GENUINE)).toBe(false); // consented conversation, no callback ask
  });

  it("ignores AI turns and label-less transcripts (conservative)", () => {
    expect(customerRequestedCallback("AI: I'll call you back tomorrow.\nUser: Okay.")).toBe(false);
    expect(customerRequestedCallback("call me tomorrow")).toBe(false); // no user turn to attribute
    expect(customerRequestedCallback(null)).toBe(false);
    expect(customerRequestedCallback("")).toBe(false);
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

// ── isConclusiveVoicemail — live kill-path classifier (voicemail auto-hangup, 2026-07-07) ──
// Runs on SINGLE final user utterances mid-call (not whole transcripts). A wrong `true` HANGS UP
// ON A LIVE CUSTOMER, so only MACHINE-EXCLUSIVE phrases kill. Adversarial review 2026-07-07
// (verified by execution) narrowed the tier: human-plausible strong phrases, the IVR combo, and
// the weak-pair rule all still LABEL transcripts (isVoicemail) but never kill. Voicemail lines
// below are verbatim from production campaign 46a33f3e (L7_CA 2026-07-06).

// Real single-utterance voicemail greetings with machine-exclusive phrases — must kill.
const LIVE_VM_KILL_LINES = [
  "forwarded to an automatic voice message system.",
  "is not available. Please leave a message after the tone.",
  "has been forwarded to voicemail. The person you're trying to reach is not available. At the tone, please record your message.",
  "voice message system. Sure.",
  "This message bank is full. Please try again later.",
];

// Voicemail-ish lines that LABEL as voicemail but are too human-plausible to KILL on —
// they fall to the LLM rule-#4 backstop (deliberate under-kill).
const LABEL_ONLY_LINES = [
  // weak-pair personal greetings (a live third party can produce the same pair)
  "Hello. You've reached Macomb's residence. If you have something important to say, please leave a message, and I'll get back to you.",
  "Hey. You've reached Terry. Leave a message, and I'll get back to you as soon as I can. Bye.",
];

// Single HUMAN utterances — every one must stay false. Includes the review's verified
// FP classes: retry-context voicemail mentions, live brush-offs, third-party answers,
// live receptionists. A true on ANY of these hangs up on a person.
const LIVE_HUMAN_LINES = [
  "Yes. Send me the details. How do I activate them?",
  "No, not interested anymore. Goodbye.",
  "Sorry, I'm not available on Tuesday.",
  "I missed your call earlier, who is this?",
  "Please leave a message with my wife.",
  "message", // bare STT fragment — a live human can utter one word
  "Yeah, I got your voicemail earlier. What's this about?", // retry-attempt opener (3× retry policy)
  "I saw you left a voicemail this morning.",
  "Sorry, I can't take your call right now, I'm driving.", // live first-person brush-off
  "He's not available right now. Do you want to leave a message?", // live third party (spouse)
  "Sorry I missed your call earlier. Did you leave a message?", // retry-context human
  "Can I record your name for the visitor log?", // live receptionist
  "Leave your details and we'll get straight back to you on your number.", // live receptionist (IVR-combo shaped)
];

describe("isConclusiveVoicemail — kills on machine-exclusive lines only", () => {
  it("fires on real machine-exclusive greeting lines", () => {
    for (const line of LIVE_VM_KILL_LINES) {
      expect(isConclusiveVoicemail(line), `should kill: "${line}"`).toBe(true);
    }
  });
  it("label-only lines: isVoicemail flags them, the kill tier does NOT", () => {
    for (const line of LABEL_ONLY_LINES) {
      expect(isVoicemail(line), `should label: "${line}"`).toBe(true);
      expect(isConclusiveVoicemail(line), `must NOT kill: "${line}"`).toBe(false);
    }
  });
  it("isVoicemail labeling is unchanged for human-plausible strong phrases", () => {
    // The split must not weaken the post-call label (goal veto + SMS follow-up rely on it).
    expect(isVoicemail("You've reached the voicemail of John. Please leave a message after the beep.")).toBe(true);
    expect(isVoicemail("The person you called cannot come to the phone. Please leave a message after the tone.")).toBe(true);
  });
});

describe("isConclusiveVoicemail — NEVER fires on live-human utterances", () => {
  it("stays false on every human line (a true here hangs up on a customer)", () => {
    for (const line of LIVE_HUMAN_LINES) {
      expect(isConclusiveVoicemail(line), `must NOT kill: "${line}"`).toBe(false);
    }
  });
  it("stays false on empty/blank input", () => {
    expect(isConclusiveVoicemail("")).toBe(false);
    expect(isConclusiveVoicemail("   ")).toBe(false);
  });
});

// ── 2026-08-27 (VOZ-463): Google Call Assist's second script ────────────────
// Every fixture below is a REAL production transcript, verbatim (ids in the
// comments). The 08-13 addition matched only the "say who you are" call screen;
// Google also answers with "I'm call assist by Google, recording this call for
// the person you're trying to reach" and then narrates the outcome. Measured
// over all 21,847 prod transcripts: 43 of these read as HUMAN, most recent
// 2026-08-24, all stored voicemail=false — so under optin_reached_only they were
// still being texted at EUR 0.032 a message.

const CALL_ASSIST = {
  // 9a29eed8, 2026-06-25 — the canonical script, said 5 times verbatim.
  canonical:
    "User: Hi. I'm call assist by Google, recording this call for the person you're trying to reach. Before I try to connect you, can I ask what you're calling about?\nAI: Goodbye.",
  // 2e1c4f8b, 2026-07-30 — STT hears "calling assist".
  asrCallingAssist:
    "User: Hi. I'm calling assist by Google recording this call for the person you're trying to reach. I try to connect you, can I ask what you're calling about?\nAI: Goodbye.",
  // b2594cf7, 2026-07-29 — STT drops the brand word entirely.
  asrCallingThisBy:
    "User: Hi. I'm calling this by Google. Recording this call for the person you're trying to reach. Can you say what you're calling about?\nAI: Goodbye.",
  // 3a069ae3, 2026-07-30 — "calling just by Google".
  asrCallingJustBy:
    "User: Hi. I'm calling just by Google recording this call for the person you're trying to reach. Before I try to connect you, can I ask what you're calling about?\nAI: Goodbye.",
  // 2fab7cb1, 2026-07-30 — "a call assistant", and STATE not SAY (the 08-13
  // pattern assumed "say", so this one slipped it twice over).
  aCallAssistantState:
    "User: Hi. I'm a call assistant recording this call for the person you are trying to reach. Please state who you are and why you're calling.\nAI: Goodbye.",
  // dad0741c, 2026-07-29 — STT cut the opening, so only the framing survives.
  truncatedOpening:
    "User: call for the person you're trying to reach. Can you say what you're calling about?\nAI: Oh, I'm calling from Lucky Seven Casino directly.",
  // e129d069, 2026-06-02 — the screener REPLIED three times. Victor talked to a
  // robot for four turns; this is the shape that reads most convincingly human.
  screenerHeldAConversation:
    "AI: Hi. It's Tom from Lucky Seven Casino. I saw you register an account with us recently. Does this sound familiar?\nUser: Who you are and why you're calling.\nAI: Hi. It's --\nUser: Please provide more detail.\nAI: Of course. I'm Tom from Lucky seven Casino.\nUser: The person you're calling is busy now. I'll let them know you called. Thank you.",
  // fb88ca30, 2026-08-20 — Call Assist narrating while it checks.
  checkingWithThePerson:
    "AI: Hey, Victor here from Lucky Seven dot com. Quick question. Have you had a chance to log in to your account recently?\nUser: One sec. Checking with the person you called.\nAI: Uh-huh. No rush.\nUser: Great. I'll share this information with the person you're trying to reach. Thanks for",
  // b7244992, 2026-08-20 — Call Assist offering to connect, then declining.
  getThePersonOnTheLine:
    "AI: Hey, Victor here from Lucky Seven dot com. Quick question. Have you had a chance to log in to your account recently?\nUser: Okay. Let me try to get the person you're trying to reach on the line.\nAI: Perfect. The reason I'm calling is\nUser: Sorry. They can't Have a great day.",
};

// Live humans who share vocabulary with the new patterns and MUST stay human.
// The full-corpus replay found zero real humans flipping; these pin the classes
// of phrase that came closest, so a future widening cannot quietly break them.
const CALL_ASSIST_REAL_HUMANS = {
  // "trying to reach" from a live wrong-number pickup, with no third-party framing.
  wrongNumber:
    "AI: Hey, Victor here from Lucky Seven dot com. Have you had a chance to log in recently?\nUser: Nah mate you've got the wrong number, who are you trying to reach?\nAI: Sorry about that.",
  // a live person taking a message for somebody else still says none of the
  // scripted phrases — this is the nearest human miss and must stay human.
  spouseTakingAMessage:
    "AI: Hey, Victor here from Lucky Seven dot com. Have you had a chance to log in recently?\nUser: He's out at the moment, can I get him to ring you? What's it regarding?\nAI: No problem.",
  // "recording" said by a live human about something else entirely.
  humanMentionsRecording:
    "AI: Hey, Victor here from Lucky Seven dot com. Have you had a chance to log in recently?\nUser: Hang on, are you recording? I'd rather you didn't. What is this about?\nAI: It's about your account.",
  // a live human asking what WE are calling about — the screener's question, but
  // asked in the first person, so none of the framing patterns can match.
  humanAsksWhatAbout:
    "AI: Hey, Victor here from Lucky Seven dot com. Have you had a chance to log in recently?\nUser: Sorry, what are you calling about exactly?\nAI: I was going over your account.",
};

describe("isVoicemail — Google Call Assist, second script (2026-08-27, VOZ-463)", () => {
  it("flags every real Call Assist shape measured in prod", () => {
    for (const [name, t] of Object.entries(CALL_ASSIST)) {
      expect(isVoicemail(t), name).toBe(true);
    }
  });

  it("keeps live humans who share the vocabulary as non-voicemail", () => {
    for (const [name, t] of Object.entries(CALL_ASSIST_REAL_HUMANS)) {
      expect(isVoicemail(t), name).toBe(false);
    }
  });

  it("NEVER feeds the mid-call kill path: Call Assist lines are label-only", () => {
    // A live human sits behind a screener often enough (475 measured 2026-08-07),
    // so a wrong kill hangs up on a customer. The label re-dials them instead.
    for (const line of [
      "Hi. I'm call assist by Google, recording this call for the person you're trying to reach.",
      "The person you're calling is busy now. I'll let them know you called.",
      "One sec. Checking with the person you called.",
      "Let me try to get the person you're trying to reach on the line.",
      "Please state who you are and why you're calling.",
    ]) {
      expect(isConclusiveVoicemail(line), line).toBe(false);
    }
  });

  it("keeps them out of the Reviews queue and the QA/golden surfaces", () => {
    // hasRealConversation gates /reviews, the QA candidate set and the golden
    // freeze. Before this change all 43 were eligible for every one of them.
    for (const [name, t] of Object.entries(CALL_ASSIST)) {
      expect(hasRealConversation(t), name).toBe(false);
    }
  });

  it("leaves the carrier 'not available at this moment' family alone (separate defect)", () => {
    // 16 of the 43 are a DIFFERENT machine family and are out of scope here, so
    // this pins the boundary: if a later change starts catching them, that is a
    // deliberate decision and this test says so out loud.
    const carrier =
      "AI: Hey, Victor here from Lucky Seven dot com. Have you had a chance to log in recently?\nUser: One b one. The client you are trying to reach is not available at this moment. Please try again later.";
    expect(isVoicemail(carrier)).toBe(false);
  });
});

// ── 2026-08-27 (fix C): the IVR "for more options" family ───────────────────
// Surfaced by the robot-texted detector's own replay: "Press hash for more options"
// texted daily 18-23 Aug under optin_reached_only. The wider family read as HUMAN in
// 244 prod transcripts (204 in August) because "press <key>" was only a weak signal
// and "for more options" lived in the eval-only list. Every fixture below is a REAL
// production transcript, trimmed. The pattern is written with the IVR grammar on
// either side of the phrase — never a bare /for more options/, because a live
// customer can say "I'm looking for more options".

const MORE_OPTIONS_MACHINES = {
  // the NZ carrier's post-greeting prompt — the bulk of the 204 August calls
  nzCarrierPrompt: `${OPENER}\nUser: When you have finished, please hang up or press the pound key for more options.\nAI: Goodbye.`,
  // the same prompt STT-clipped to its tail — 67 measured, the shape "strict" first missed
  clippedTail: `${OPENER}\nUser: for more options. or just hang up.\nAI: Goodbye.`,
  // 8 of these were TEXTED 18-23 Aug — the leak the detector found
  pressHash: `${OPENER}\nUser: Press hash for more options.\nUser: or just hang up.\nAI: Goodbye.`,
  // the recording menu, both orders it comes in
  recordingMenu: `${OPENER}\nUser: To send this message now, press pound or hang up. To leave a callback number, press one. To replay your message, press three. For additional options, press nine.`,
  recordingMenuReversed: `${OPENER}\nUser: To leave a callback number, press one. To send this message now, press pound or hang up.`,
  // "That's all you can record" family — the human-sounding first turn is the greeting
  thatsAllYouCanRecord: `${OPENER}\nUser: Give your name and number, and I'll give it to you. Thank you.\nUser: That's all you can record. To save this message, just hang up. For more options, press one.`,
  // AU: the classic tail
  auHangUpOrPress: `${OPENER}\nUser: You can hang up, or press pound for more options.\nAI: Goodbye.`,
  // bare fragments as the ENTIRE customer turn (16 measured) — the whole-turn rule
  bareFragment: `${OPENER}\nUser: For more options.\nAI: Goodbye.`,
  bareFragmentWithKey: `${OPENER}\nUser: Pound for more options.\nAI: Goodbye.`,
  // STT hears "cash" for "hash" — still the IVR grammar on the right
  sttCash: `${OPENER}\nUser: Cash for more options or just hang up.\nAI: Goodbye.`,
};

// Live humans who share vocabulary with the family and MUST stay human.
const MORE_OPTIONS_HUMANS = {
  // the sentence the loose pattern would have caught — the reason it is not loose
  lookingForMoreOptions: `${OPENER}\nUser: Yeah I'm looking for more options on the bonus to be honest, what else have you got?\nAI: Sure, let me explain.`,
  // "hang up" from a human, no "press" anywhere
  humanHangsUp: `${OPENER}\nUser: Sorry I'm going to hang up now, I'm at work.\nAI: No problem.`,
  // "press" from a human about a button, not a menu
  humanPressed: `${OPENER}\nUser: Hang on I pressed the wrong thing. Who is this?\nAI: It's Victor from Lucky Seven.`,
  // a human continuing PAST the fragment — the whole-turn rule must not fire
  fragmentThenSpeech: `${OPENER}\nUser: For more options I'd have to log in first, is that right?\nAI: That's right.`,
  // the phrase "options" alone, in a real conversation
  talksOptions: `${OPENER}\nUser: What are my options here?\nAI: You have twenty free spins waiting.\nUser: Okay, and the bonus?`,
};

describe("isVoicemail — the IVR 'for more options' family (2026-08-27, fix C)", () => {
  it("flags every measured machine shape", () => {
    for (const [name, t] of Object.entries(MORE_OPTIONS_MACHINES)) {
      expect(isVoicemail(t), name).toBe(true);
    }
  });

  it("keeps every human who shares the vocabulary", () => {
    for (const [name, t] of Object.entries(MORE_OPTIONS_HUMANS)) {
      expect(isVoicemail(t), name).toBe(false);
    }
  });

  it("the bare fragment is whole-turn only: a human continuing past it never matches", () => {
    expect(isVoicemail(`${OPENER}\nUser: for more options I would need to see the site first.`)).toBe(false);
    expect(isVoicemail(`${OPENER}\nUser: For more options.`)).toBe(true);
  });

  it("NEVER feeds the mid-call kill path: every shape is label-only", () => {
    for (const [name, t] of Object.entries(MORE_OPTIONS_MACHINES)) {
      // isConclusiveVoicemail is fed a single utterance, never a whole transcript
      const lastUser = t.split("\n").filter((l) => l.startsWith("User: ")).pop()!.slice(6);
      expect(isConclusiveVoicemail(lastUser), name).toBe(false);
    }
  });

  it("keeps them out of the Reviews queue and the QA/golden surfaces", () => {
    for (const [name, t] of Object.entries(MORE_OPTIONS_MACHINES)) {
      expect(hasRealConversation(t), name).toBe(false);
    }
  });
});

// ── 2026-08-28: the seventh sweep found no seventh family — it found the classifier's blind
// spot on ORDINARY voicemail greetings. Method (the one that surfaced "press hash" on 08-27, run
// deliberately): every transcript isVoicemail still called HUMAN with exactly one substantive
// customer turn, grouped by shape, top groups read. 857 machines were counted as reached humans,
// 720 of them in August, 160 texted. Every user turn below is VERBATIM from a prod transcript.
// Each fixture matches exactly ONE new pattern, so disabling that pattern turns its line red.
const GAP_OPENER = "AI: Hi. It's Tom from Lucky seven Casino. Does this sound familiar?";
const VOICEMAIL_GAP_0828 = {
  atTheToneRecord: "At the tone, record your message.", // 358 — the biggest single miss
  orJustHangUp: "More options? or just hang up.", // 108 — STT clipped the "for" that fix C anchored on
  asAnAudioMessage: "and as an audio message.", // 74 — STT drops the "sent" the 06-16 pattern needs
  toConnectYourCallPress: "To connect your call, press seven.", // 58 — call-screen IVR
  sendMessageAsText: "after the tone and will send the message as a text.", // 53 — carrier voicemail-to-text
  youMayHangUp: "Recording, you may hang up.", // 52 — "finished recording" needs "finished"
  pleaseLeaveAMessage: "Please leave a message.", // 49 — alone it was one weak signal, never two
  noRoomToRecord: "Sorry. There's no more room to record new messages.", // 26 — full mailbox, other wording
  mailboxCannotReceive: "This mailbox cannot receive messages at this time.", // 20
  callControl: "This number has call control. To get through, please press four.", // 19 — AU call screen
  satisfiedWithYourMessage: "If you are satisfied with your message, press one. To listen to your message, press two. To erase and rerecord, press three.", // 18
  cantTakeYourMessage: "Hi. The person you have called is not available. We can't take your message at this time. Please call again later. Goodbye.", // 10
  noMessageCanBeLeft: "No message can be left on this service. Zero four six zero eight nine one six nine nine. Goodbye.", // 6
  recallYourName: "If you recall your name and reason for calling, I'll see if this person is available.", // 9 — STT "recall" for "record"
};
// Read and REJECTED on 2026-08-28 — pinned here so a later widening turns red:
//   • "To leave a callback number, press five" flipped ONE real human (four conversational turns
//     before it). The bar is zero.
//   • "I'll get back to you" is a live brush-off; the weak tier carries it deliberately (08-13).
const VOICEMAIL_GAP_0828_HUMANS = {
  realHumanThenCallbackMenu: `${GAP_OPENER}\nUser: Hello?\nAI: It's Tom from Lucky seven Casino.\nUser: Who is this?\nUser: I don't know what this is.\nUser: Okay. This is Anthony.\nUser: To leave a callback number, press five.`,
  liveBrushOffGetBack: `${GAP_OPENER}\nUser: Sorry, I'm in a meeting. Leave it with me and I'll get back to you.`,
};

describe("isVoicemail — ordinary voicemail greetings the classifier missed (2026-08-28)", () => {
  it("flags every measured greeting", () => {
    for (const [name, turn] of Object.entries(VOICEMAIL_GAP_0828)) {
      expect(isVoicemail(`${GAP_OPENER}\nUser: ${turn}\nAI: Goodbye.`), name).toBe(true);
    }
  });

  it("keeps the read-and-rejected humans human", () => {
    for (const [name, t] of Object.entries(VOICEMAIL_GAP_0828_HUMANS)) {
      expect(isVoicemail(t), name).toBe(false);
    }
  });

  it("NEVER feeds the mid-call kill path: every greeting is label-only", () => {
    for (const [name, turn] of Object.entries(VOICEMAIL_GAP_0828)) {
      expect(isConclusiveVoicemail(turn), name).toBe(false);
    }
  });

  it("keeps them out of the Reviews queue and the QA/golden surfaces", () => {
    for (const [name, turn] of Object.entries(VOICEMAIL_GAP_0828)) {
      expect(hasRealConversation(`${GAP_OPENER}\nUser: ${turn}\nAI: Goodbye.`), name).toBe(false);
    }
  });
});

// ── 2026-08-28: responsible-gambling disclosures. Found while auditing the opt-out regex.
// SIX real disclosures across 22,041 prod transcripts; THREE received a promotional SMS
// afterwards. The two handled correctly were handled BY ACCIDENT — the agent's own reply
// ("Do you want me to note your account so we don't call you again?") happened to match
// processEndOfCall's opt-out regex, which scans AI turns too. Nothing in the codebase was
// looking for the customer saying it. Every fixture below is verbatim customer speech.
const RG_OPENER = "AI: Hey, Victor here from Lucky seven dot com. Have you had a chance to log in recently?";
const rgCall = (turn: string) => `${RG_OPENER}\nUser: ${turn}\nAI: Goodbye.`;

const RG_DISCLOSURES: Record<string, { turn: string; category: RiskDisclosureCategory }> = {
  // harm — the most urgent: stop pitching, never text, and a human must see it
  killMyself: { turn: "This is not twenty three spins in my account. I'm going to kill myself right now.", category: "harm" },
  killEveryone: { turn: "Then kill myself and everyone around me.", category: "harm" },
  endMyLife: { turn: "Honestly I just want to end my life over this.", category: "harm" },
  suicidal: { turn: "Mate, this stuff has left me suicidal. I can't do it anymore.", category: "harm" },
  // self-exclusion — a regulated status; marketing to these players is the breach
  selfExclusionStated: { turn: "My account is is under self exclusion.", category: "self_exclusion" },
  selfExcludedShort: { turn: "No. I got a self excluded.", category: "self_exclusion" },
  betstop: { turn: "I signed up to BetStop last year, mate.", category: "self_exclusion" },
  bannedMyself: { turn: "I banned myself from all that months ago.", category: "self_exclusion" },
  // problem gambling
  addiction: { turn: "Couldn't see I had a addiction one, turned to two, turned to three, then I need about six a day.", category: "problem_gambling" },
  gamblingProblem: { turn: "Look, I've got a gambling problem, alright?", category: "problem_gambling" },
  quitGambling: { turn: "No. We quit gambling.", category: "problem_gambling" },
};

// Speech that must NEVER fire it. The cost of a false positive here is a permanently
// suppressed customer we were mandated to text, so these are load-bearing.
const RG_NOT_DISCLOSURES = {
  ordinaryDecline: rgCall("No thanks, I'm not interested today."),
  abuse: rgCall("How about you go fuck yourself, scammers."), // abuse => DNC, but NOT a risk disclosure
  agentSaysIt: `${RG_OPENER}\nAI: If you're self excluded I won't push anything promotional. Do you want me to note your account so we don't call you again?\nUser: Yeah okay.\nAI: Goodbye.`,
  talkingAboutSomeoneElse: rgCall("My brother had a gambling problem, but I'm fine."),
  gameAddictive: rgCall("That game is addictive, I love it."),
  voicemailGreeting: `${RG_OPENER}\nUser: At the tone, record your message.\nAI: Goodbye.`,
};

describe("customerRiskDisclosure — responsible-gambling signals (2026-08-28)", () => {
  it("flags every measured disclosure, with the right category", () => {
    for (const [name, { turn, category }] of Object.entries(RG_DISCLOSURES)) {
      const got = customerRiskDisclosure(rgCall(turn));
      expect(got, name).not.toBeNull();
      expect(got?.category, name).toBe(category);
    }
  });

  it("harm outranks everything — it decides the response", () => {
    // Against BOTH lower tiers, and across turns as well as within one: the tier order is the
    // thing that picks which alert a human gets, so it is pinned in every direction.
    expect(customerRiskDisclosure(rgCall("I've got a gambling problem and I'm going to kill myself."))?.category).toBe("harm");
    expect(customerRiskDisclosure(rgCall("I am self excluded and honestly I want to end my life."))?.category).toBe("harm");
    expect(customerRiskDisclosure(
      `${RG_OPENER}\nUser: I am self excluded.\nAI: Understood.\nUser: I'm going to kill myself.\nAI: Goodbye.`,
    )?.category).toBe("harm");
  });

  it("never fires on speech that is not a disclosure", () => {
    for (const [name, t] of Object.entries(RG_NOT_DISCLOSURES)) {
      expect(customerRiskDisclosure(t), name).toBeNull();
    }
  });

  it("reads the CUSTOMER only — the agent saying it is not a disclosure", () => {
    // This is the whole bug: prod's opt-out regex scanned AI turns, so the agent OFFERING
    // to suppress ("Do you want me to mark you as do not call?") suppressed the number
    // whether or not the customer agreed. 5 such transcripts measured.
    expect(customerRiskDisclosure(RG_NOT_DISCLOSURES.agentSaysIt)).toBeNull();
    expect(customerRiskDisclosure(`${RG_OPENER}\nAI: I'm going to kill myself.\nUser: What?`)).toBeNull();
  });

  it("returns a short, digit-masked excerpt for the alert (no phone numbers into Slack)", () => {
    const got = customerRiskDisclosure(rgCall("Call me on 0412345678, I am self excluded."));
    expect(got?.category).toBe("self_exclusion");
    expect(got?.excerpt).not.toMatch(/\d{3,}/);
    expect(got!.excerpt.length).toBeLessThanOrEqual(160);
  });

  it("empty / label-less / machine input is never a disclosure", () => {
    expect(customerRiskDisclosure("")).toBeNull();
    expect(customerRiskDisclosure(null)).toBeNull();
    expect(customerRiskDisclosure(undefined)).toBeNull();
    expect(customerRiskDisclosure("   \n  ")).toBeNull();
  });

  it("is capped like every other classifier — a huge transcript is not scanned in full", () => {
    const filler = `${RG_OPENER}\nUser: ok.\n`.repeat(2000);
    expect(filler.length).toBeGreaterThan(32_000);
    expect(customerRiskDisclosure(filler + "\nUser: I am self excluded.")).toBeNull();
  });
});
