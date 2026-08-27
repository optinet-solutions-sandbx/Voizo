// Shared transcript classification for the Reviews queue.
//
// Speaker parsing + voicemail patterns are ported from the end-of-call webhook
// (src/app/api/webhooks/vapi/end-of-call/route.ts). Kept as a SEPARATE copy on
// purpose: that webhook is call-path code we don't disturb for a slice-1 feature.
// TODO (separate, reviewed change): DRY the webhook to import from here.

export type TranscriptSpeaker = "ai" | "user" | "unknown";
export interface TranscriptTurn {
  speaker: TranscriptSpeaker;
  text: string;
}

const TRANSCRIPT_CAP = 32_000;

/**
 * Parse Vapi's flat, speaker-labelled transcript into ordered turns. Handles
 * both observed formats — "User\n[text]" and "User: [text]" — and skips stray
 * timestamp lines like "4:48:40 PM(+00:00.61)".
 */
export function parseTranscriptTurns(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const lines = transcript.split(/\r?\n/);
  let currentSpeaker: TranscriptSpeaker = "unknown";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").trim();
    if (text) turns.push({ speaker: currentSpeaker, text });
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?(\s*\(\+?[\d:.]+\))?$/i.test(line)) continue;

    if (/^(?:AI|Assistant|Bot)$/i.test(line)) { flush(); currentSpeaker = "ai"; continue; }
    if (/^(?:User|Customer|Caller|Human)$/i.test(line)) { flush(); currentSpeaker = "user"; continue; }

    const aiInline = line.match(/^(?:AI|Assistant|Bot):\s*(.*)$/i);
    if (aiInline) { flush(); currentSpeaker = "ai"; if (aiInline[1]) buffer.push(aiInline[1]); continue; }
    const userInline = line.match(/^(?:User|Customer|Caller|Human):\s*(.*)$/i);
    if (userInline) { flush(); currentSpeaker = "user"; if (userInline[1]) buffer.push(userInline[1]); continue; }

    buffer.push(line);
  }
  flush();
  return turns;
}

// Voicemail / answering-machine detection — TWO tiers. Short AU "message bank"
// greetings (e.g. "This message bank is full.") emit only 0-1 generic matches and
// slipped the >=2 threshold below, surfacing as FAKE "real conversations" in
// /reviews (campaign 9df71cd3, 2026-06-03). The strong tier fixes that.
//
// STRONG — unambiguous machine phrases; a SINGLE match is conclusive for the
// post-call LABEL (isVoicemail). Split 2026-07-07 (adversarial review of the
// live kill path) into two groups by a stricter bar — could a LIVE human
// plausibly utter this? — because the kill tier (isConclusiveVoicemail) hangs
// up mid-call on one match, where a false positive hangs up on a customer.
//
// MACHINE-EXCLUSIVE — scripted greeting/carrier boilerplate no live speaker
// produces. Safe as a single-match KILL trigger.
const VOICEMAIL_MACHINE_EXCLUSIVE_PATTERNS = [
  /\bmessage bank\b/i, // AU/UK term for voicemail
  /\b(?:voice |automated )?(?:messaging|answering) (?:system|service)\b/i, // "automated voice messaging system"
  /\bforwarded to (?:an? )?automated\b/i,
  /\bmailbox (?:is )?full\b/i,
  /(?:finished|done) recording/i, // "when you have finished recording, you may hang up"
  /leave (?:a |your )?(?:detailed |brief |short )?message (?:after|at)\b/i, // "...message after the tone" — the tone imperative is greeting script
  /please record (?:your )?message/i,
  // #4 (2026-06-08): carrier voicemail-to-text divert + conversion notices — verbatim machine boilerplate.
  /hang up before the tone/i,
  /will be sent in a text message to the person you called/i,
  /your (?:voice )?message is being converted to text/i,
  /standard call charges apply if you proceed/i,
  /sent as an? (?:audio|text|voice) message\b/i, // "...will be sent as an audio message" (dominant AU greeting)
  /\bmailbox number\b/i, // "you have reached mailbox number ..."
  /voice message system\b/i, // "forwarded to an automatic voice message system"
];
// HUMAN-PLAUSIBLE strong — conclusive for LABELING a whole transcript, but a
// live speaker can say these, so they must never trigger a kill (2026-07-07
// review, verified by execution): "I got your VOICEMAIL earlier" is an expected
// opener on retry attempts (3× policy); "I CAN'T TAKE YOUR CALL right now, I'm
// driving" is a live brush-off; "can I RECORD YOUR NAME" is a live receptionist;
// "he CANNOT COME TO THE PHONE" is a live third party.
const VOICEMAIL_STRONG_HUMAN_PLAUSIBLE_PATTERNS = [
  /\bvoice\s*mail(?:box)?\b/i, // incl. "voice mailbox"
  /\bvoicemail\b/i,
  /(?:can'?t|cannot|can not|are not able to|unable to) take your call/i,
  /\brecord your name\b/i, // "if you record your name and reason for calling" (virtual receptionist / call screen)
  /cannot come to the (?:phone|telephone)\b/i, // "the person you called cannot come to the phone"
  // 2026-08-13: call-screener script + carrier announce. #5's MACHINE_GREETING_PATTERNS
  // below already knew these shapes but was deliberately eval-only, reasoning that
  // dispatch was protected by hasGenuineCustomerConsent — TRUE for verbal_yes, but
  // optin_reached_only (2026-08-07) made deriveAttemptTag (built on THIS label) the
  // dispatch trigger, so screener pickups tagged 'neutral' were texted: 27 of 53 SMS on
  // 2026-08-13 went to machines/screeners. These two are verbatim machine scripts no
  // live caller produces, so plain substring is safe; the human-plausible screener
  // line ("please stay on the line") gets a turn-shaped rule instead — see
  // allUserTurnsAreScreenerScript below. In this tier they label only — never kill —
  // because a live human can sit behind a screener (475 measured 2026-08-07), and the
  // label's voicemail routing re-dials them later, which is exactly right for a screener.
  /\b(?:say|state) who you are and why you(?:'re| are)? calling\b/i, // Google/Samsung call screen script
  /\bthe number you have (?:dialled|dialed|called)\b/i, // carrier announce ("...has not been recognized")
  // 2026-08-27 (VOZ-463): Google Call Assist's OTHER script. The 08-13 addition
  // above matched only the "say who you are" screen; Google also runs
  //   "Hi. I'm call assist by Google, recording this call for the person you're
  //    trying to reach. Before I try to connect you, can I ask what you're
  //    calling about?"
  // and then narrates the outcome ("Checking with the person you called", "The
  // person you're calling is busy now", "Let me try to get the person you're
  // trying to reach on the line"). Measured over all 21,847 prod transcripts:
  // 43 screener-shaped calls that isVoicemail read as HUMAN, 17 in 2026-07 and
  // 17 in 2026-08, most recent 2026-08-24 — every one stored voicemail=false,
  // so under optin_reached_only deriveAttemptTag kept texting them.
  //
  // The BRAND phrase is not dependable: STT renders "call assist" as "calling
  // assist by Google", "calling this by Google", "calling just by Google" and
  // "a call assistant". What survives every mangling is the THIRD-PARTY framing
  // — the speaker is answering FOR somebody else — so that is what these match.
  // Also verbatim: "state" where the 08-13 pattern assumed "say" (widened above).
  //
  // Label tier, never the kill tier, for the same reason as the 08-13 pair: a
  // live human sits behind a screener often enough (475 measured 2026-08-07),
  // and the voicemail label re-dials them, which is the right outcome. Replayed
  // over the full corpus: 27 of the 43 flip to voicemail and ZERO of the 7,755
  // currently-human transcripts do. The remaining 16 are a DIFFERENT machine
  // family (carrier "the client you are trying to reach is not available at this
  // moment") and are deliberately left alone here.
  /\bfor the person (?:you(?:'re| are) (?:trying to reach|calling)|you called)\b/i,
  /\brecording this call\b/i,
  /\bcall(?:ing)? assist(?:ant)?(?:\s+\w+){0,2}\s+by google\b/i, // incl. "calling just by Google"
  /\b(?:i'?m|this is) an? call assistant\b/i,
  /\bthe person you(?:'re| are) calling is (?:busy|unavailable|not available)\b/i,
  /\bwith the person you (?:called|'re calling|are calling)\b/i, // "Checking with the person you called"
  /\bget the person you(?:'re| are) (?:trying to reach|calling)\b/i, // "...on the line"
];
// Post-call labeling keeps the FULL set — isVoicemail behavior is unchanged.
const VOICEMAIL_STRONG_PATTERNS = [
  ...VOICEMAIL_MACHINE_EXCLUSIVE_PATTERNS,
  ...VOICEMAIL_STRONG_HUMAN_PLAUSIBLE_PATTERNS,
];

// WEAK — generic greeting fragments that can appear incidentally in a real call.
// 2+ distinct matches = voicemail (a real customer rarely emits two; a greeting emits 3-5).
const VOICEMAIL_GREETING_PATTERNS = [
  /\bleave (?:me |us )?(?:a |your )?(?:detailed |brief |short )?messages?\b/i, // incl. "leave me a (short) message"
  /after the (?:tone|beep)/i,
  /at the sound of the (?:tone|beep)/i,
  /\bpress (?:\d|one|two|three|four|five|six|seven|eight|nine|the \w+ key|hash|pound|star)\b/i,
  /\byou(?:'?ve| have) reached\b/i, // incl. full-form "you have reached"
  /\bnot available\b/i,
  /\bplease hold\b/i,
  /\ball (?:our )?(?:representatives|agents|operators)\b/i,
  /\byour call is important\b/i,
  // Ernie ticket (2026-06-16): more generic carrier/personal-greeting fragments — each pairs with
  // another weak signal (>=2) so a lone occurrence in a real call never trips the filter.
  /missed your call\b/i, // "sorry I missed your call"
  /\bleave (?:your |me your |us your )?name(?: and (?:number|phone))?\b/i, // "leave your name and number"
  /\b(?:i'?m|i am) (?:currently )?unavailable\b/i, // "I'm unavailable right now"
  // 2026-08-13: two more greeting fragments measured on live traffic. Each needs a
  // pair (>=2 rule), so a live brush-off ("I'll get back to you shortly") never trips
  // alone — the greetings that leaked both pair up: "leave your name, number, and a
  // short message" and "just leave a message, and I'll get back to you".
  /\b(?:get|getting) back to you\b/i,
  /\ban? (?:short|brief|quick) message\b/i,
  // Phase A replay (8,140 calls): "After LEAVING a message, you can hang up, or press
  // pound for more options" — the gerund dodges the 'leave a message' pattern above,
  // so the whole carrier family (39 measured) read as humans. Pairs with press-pound.
  /\bleaving (?:a |your )?message\b/i,
];

// #4 (2026-06-08): IVR / answering greeting that asks the caller to leave a callback number.
// Combined (BOTH phrases) so a lone polite line never fires.
function isIvrCallback(s: string): boolean {
  return /we'?ll get (?:straight )?back to you/i.test(s) && /(?:your|the) (?:phone )?number/i.test(s);
}

// Bare machine fragments STT renders as a WHOLE "user" turn: "Message.", "Your message.",
// "The message is a text.", or a spelled-out-digit-only run (>=2 number words — e.g. a callback
// number read back by a machine). Whole-turn match only — never a substring.
const NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|oh)";
const DIGIT_RUN = new RegExp(`^${NUMBER_WORD}(?:\\s+${NUMBER_WORD}){1,}$`, "i");
function isBareMachineFragment(text: string): boolean {
  const t = text.trim().replace(/[.?!]+$/, "").trim();
  if (!t) return false;
  return (
    /^(?:your |a )?message$/i.test(t) ||
    /^the message is a text$/i.test(t) ||
    // 2026-08-13: the tail of the dominant AU carrier greeting "...will be sent as an
    // audio message" (already a STRONG pattern in full) as STT actually delivers it —
    // the fragment alone was the entire user turn on 51 calls on 2026-08-13, which all
    // surfaced as fake 'early hang-up' humans. Whole-turn only, like every fragment here.
    /^(?:as )?(?:an )?audio message$/i.test(t) ||
    DIGIT_RUN.test(t)
  );
}

// True only when EVERY substantive user turn is a bare machine fragment. A real human always
// emits >=1 non-fragment turn, so this cannot fire on a genuine conversation. With no speaker-
// labelled user turns, treats the whole string as the sole candidate (so single-turn callers —
// e.g. isGenuineAssentTurn screening one assent — still classify correctly).
function allUserTurnsAreMachineFragments(transcript: string): boolean {
  const turns = parseTranscriptTurns(transcript);
  const userTurns = turns.filter((t) => t.speaker === "user").map((t) => t.text);
  const candidates = userTurns.length ? userTurns : [transcript.trim()];
  return candidates.length > 0 && candidates.every(isBareMachineFragment);
}

// 2026-08-13: the Telstra/handset screener scripts. "Thanks. Please stay on the line."
// answered 21 dials on 2026-08-13 (every one texted as a fake 'neutral'), sometimes
// STT-split into two turns ("Thanks." / "Please stay on the line."). Unlike the two
// screener patterns in the strong tier, this phrase IS live-human-plausible ("stay on
// the line while I grab a pen"), so it must not match as a substring — instead the
// call is a screener only when EVERY user turn is the script or a bare courtesy, i.e.
// the screener was the entire "conversation". A human who says it while engaging has
// at least one other genuine turn and never fires this (same architecture as
// allUserTurnsAreMachineFragments).
// 2026-08-14 (VOZ-388): accept the phrase TRUNCATED mid-script ("Please stay on" /
// "...on the") — when the agent talks over the screener, STT cuts the line short and
// the whole-phrase form missed it (+61430221843 texted 08-14; twin on 08-13). Still
// whole-turn anchored: a human continuing past the phrase ("...the phone, I'll get
// him") never matches. Replayed over 9,060 prod calls: only the two measured
// truncated screeners flip, zero real humans.
const SCREENER_SCRIPT_TURN = /^(?:thank(?:s| you)?[.,!]?\s+)*please stay on(?: the(?: line)?)?[.,!]?$/i;
const COURTESY_TURN = /^thank(?:s| you)?[.,!]?$/i;
function allUserTurnsAreScreenerScript(transcript: string): boolean {
  const turns = parseTranscriptTurns(transcript);
  const userTurns = turns.filter((t) => t.speaker === "user").map((t) => t.text.trim());
  const candidates = userTurns.length ? userTurns : [transcript.trim()];
  return (
    candidates.some((t) => SCREENER_SCRIPT_TURN.test(t)) &&
    candidates.every((t) => SCREENER_SCRIPT_TURN.test(t) || COURTESY_TURN.test(t))
  );
}

export function isVoicemail(transcript: string): boolean {
  if (!transcript) return false;
  const safe = transcript.slice(0, TRANSCRIPT_CAP);
  if (VOICEMAIL_STRONG_PATTERNS.some((p) => p.test(safe))) return true;
  if (isIvrCallback(safe)) return true;
  if (VOICEMAIL_GREETING_PATTERNS.filter((p) => p.test(safe)).length >= 2) return true;
  if (allUserTurnsAreScreenerScript(safe)) return true; // 2026-08-13 screener leak
  return allUserTurnsAreMachineFragments(safe);
}

/**
 * Live kill-path classifier (voicemail auto-hangup, 2026-07-07): is this SINGLE
 * final user utterance conclusively a machine? Used mid-call by the end-of-call
 * route's `transcript` branch to end the call via Live Call Control — a wrong
 * `true` hangs up on a live customer, so ONLY machine-exclusive phrases fire.
 *
 * Deliberately narrower than isVoicemail (adversarial review 2026-07-07,
 * FP classes verified by execution): human-plausible strong phrases ("I got
 * your voicemail earlier" on a retry, "can't take your call, I'm driving"),
 * the IVR callback combo ("leave your number, we'll get back to you" — a live
 * receptionist line), and the weak-pair rule ("he's not available… want to
 * leave a message?" — a live third party) all label transcripts but never kill.
 * Under-kill is the correct failure mode: misses fall to the prompt rule-#4
 * LLM backstop (~27s) + silence/maxDuration caps.
 *
 * NOT reusable via isVoicemail(line): its bare-fragment tier would return true
 * for a human uttering the single word "message" (its all-turns guard only
 * makes that safe on whole transcripts). Any kill-tier match is a subset of
 * STRONG, so a killed call's transcript still labels isVoicemail=true — the
 * goal_reached veto and registered_optin voicemail-followup SMS keep working.
 */
export function isConclusiveVoicemail(utterance: string): boolean {
  if (!utterance) return false;
  const safe = utterance.slice(0, TRANSCRIPT_CAP);
  return VOICEMAIL_MACHINE_EXCLUSIVE_PATTERNS.some((p) => p.test(safe));
}

// ── Genuine customer consent ────────────────────────────────────────────────
// Used by the end-of-call webhook to gate goal_reached + SMS on the transcript-
// fallback path. Requires a REAL customer assent (speaker-aware, machine-
// screened, negation-guarded) — never the agent's own scripted line. Conservative
// on label-less transcripts. First-cut lexicon/window; calibrated by validation.

// Assent words a human says to agree. NOT "please" alone (politeness — fires on
// machine "Please leave a message"/"Please hold"). Bare "y" tolerated (STT "Yes"
// -> "Y."), and bare "k" for the same reason (observed in real calls as "k." and
// "Right. k. Thank you.") as its own `|k` alternative. NOT `o?k(?:ay)?` — that
// shape also matches the bare word "kay", so a customer saying "This is Kay."
// registered as consent (session code-review finding, 2026-07-28). With `k` as
// a separate alternative, \b after it rejects "kay" (k→a is not a boundary)
// while "k.", "ok", "okay" all still match.
//
// "no worries" / "no problem" (VOZ-245, 2026-07-28): plain agreement in AU
// English — our largest volume — and previously unreachable, because the bare
// "no" in CONSENT_NEGATION vetoed the turn before the assent could count. Paired
// with the negation guard below; "yeah nah" (an AU REFUSAL) must still be vetoed,
// which it is, on the separate "nah" alternative.
//
// NOT added, deliberately (measured 2026-07-28 over 134 real offers): gratitude
// ("thank you", "thanks", "cheers") and backchannel ("mm-hmm", "uh-huh").
// Gratitude appears on BOTH sides in our own transcripts — "Okay. Thank you."
// agrees while "No. Thank you." / "I'm good. Thank you." / "No thanks" refuse —
// so counting it would have flipped real declines into consent (and, in
// verbal_yes campaigns, texted people who had just said no). Backchannel noises
// are in the agent's own approved-filler list, so they signal listening, not
// agreement. Vague-but-real agreement needs a model, not a lexicon — see VOZ-246.
const ASSENT_WORD =
  /\b(?:y(?:eah|es|up|ep)?|sure|of course|ok(?:ay)?|k|alright|all right|fine|correct|go (?:ahead|on)|carry on|fire away|sounds (?:good|great|perfect)|will do|definitely|absolutely|no worries|no problem)\b/i;

/**
 * An explicit customer INSTRUCTION to send (VOZ-245). Stronger consent than
 * "okay" — the customer is directing the action — yet it used to fall through
 * because no bare assent word appears: "You can send me an SMS.", "Send it
 * over.", "Please do." were all observed in real calls and thrown away.
 *
 * Safe against the mirror-image phrasing ("you don't have to send the SMS",
 * also observed) because CONSENT_NEGATION is checked FIRST and catches the
 * "don't"; and against machine greetings because isVoicemail screens the turn
 * before either pattern runs.
 */
const SEND_INSTRUCTION =
  /\b(?:(?:you can|you could|please|feel free to|go ahead and)\s+(?:send|text)|send (?:it|that|them|those|me|the (?:sms|text|link|details|info))|text (?:it|me|that)|please do)\b/i;

// The bare "no" alternative must not swallow the AU grant-idioms above ("yeah no
// worries", "no problem"). Mirrors the same negative-lookahead trick the
// SMS_DECLINE_PATTERNS use for "don't mind/worry/forget". Every other refusal
// shape is untouched: "no thanks", "No. Thank you.", "nah", "yeah nah".
const CONSENT_NEGATION =
  /\b(?:no(?!\s+(?:worries|worry|problem|probs|stress|dramas))|nope|nah|don'?t|do not|not (?:interested|now|really)|rather not|leave it|forget it|never|stop)\b/i;

// AI turn that offers OR confirms sending an SMS (need not be a question).
const AI_SMS_MENTION =
  /\b(?:send|sending|sent|text|texting)\b[^.?!]{0,60}\b(?:sms|text|message|details|link|info)\b/i;

const CONSENT_WINDOW = 4; // assent must land within N turns of an AI SMS mention

function isGenuineAssentTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (isVoicemail(t)) return false; // machine-screen the assent turn itself
  if (CONSENT_NEGATION.test(t)) return false; // MUST stay above both patterns below
  return ASSENT_WORD.test(t) || SEND_INSTRUCTION.test(t);
}

/**
 * Did a REAL customer genuinely agree to receive the SMS? Speaker-aware,
 * machine-screened, negation-guarded. Conservative (false) when no AI/User
 * turns can be parsed (label-less transcript).
 */
export function hasGenuineCustomerConsent(transcript: string | null | undefined): boolean {
  if (!transcript) return false;
  const turns = parseTranscriptTurns(transcript.slice(0, TRANSCRIPT_CAP));
  if (!turns.some((t) => t.speaker === "ai")) return false; // label-less / no AI side -> cannot establish

  let aiMentionIdx = -1;
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.speaker === "ai" && AI_SMS_MENTION.test(turn.text)) {
      aiMentionIdx = i;
      continue;
    }
    if (aiMentionIdx < 0 || i - aiMentionIdx > CONSENT_WINDOW) continue;
    if (turn.speaker !== "user") continue;
    if (isGenuineAssentTurn(turn.text)) return true;
  }
  return false;
}

// ── SMS dispatch signals (2026-06-11, registered_optin mode) ────────────────
// Used by the end-of-call webhook's mode-aware dispatch (smsDispatchDecision).
// Same conservative stance as hasGenuineCustomerConsent: label-less transcripts
// yield false (no speaker evidence → no dispatch evidence).

// Announce trigger for registered_optin dispatch. STRICTER than AI_SMS_MENTION
// (which feeds the consent window and may stay broad): an announce must be
// channel-certain — either a texting VERB ("I'll text you / text it over") or a
// send-verb paired with an sms/text/message NOUN. "I'll send you an email with
// the details" must NOT arm an SMS (review H1); "I'll text you" / "shoot you a
// text" must (review H2).
const AGENT_SMS_ANNOUNCE =
  /\b(?:text(?:ing)?\s+(?:you|it|this|that|them|everything|the)\b|(?:send|sending|sent|shoot|shooting)\b[^.?!]{0,60}\b(?:sms|texts?|messages?)\b)/i;

/**
 * Did the AGENT announce/offer a text? AI turns only — a customer asking
 * "can you text me?" is consent territory, not an agent announce.
 */
export function agentMentionedSms(transcript: string | null | undefined): boolean {
  if (!transcript) return false;
  const turns = parseTranscriptTurns(transcript.slice(0, TRANSCRIPT_CAP));
  return turns.some((t) => t.speaker === "ai" && AGENT_SMS_ANNOUNCE.test(t.text));
}

// Explicit, text-directed refusals ONLY. Deliberately narrow: a generic "no"
// is an offer-decline (verbal_yes mode / outcome territory), not an SMS veto,
// and AU grant-idioms ("yeah no worries", "no problem") must never match.
const SMS_DECLINE_PATTERNS = [
  // negation + a texting verb/noun in the same clause; (?! mind| worry| forget)
  // keeps grant-idioms ("I don't mind the text", "don't worry about sending it")
  // AND voicemail greetings ("don't forget to leave a message after the beep" —
  // greeting speech parses as user turns) out of the veto (reviews M3 + M2').
  /\b(?:don'?t|do not|didn'?t|wouldn'?t|stop|never)\b(?! mind\b| worry\b| forget\b)[^.?!]{0,30}\b(?:text(?:s|ing)?|sms|messages?|send(?:ing)?)\b/i,
  /\bno (?:more )?(?:texts?|sms|messages?)\b/i,
  /\bno need to (?:text|sms|message|send)\b/i,
];

/** Did the CUSTOMER explicitly decline being texted? User turns only. */
export function customerDeclinedSms(transcript: string | null | undefined): boolean {
  if (!transcript) return false;
  const turns = parseTranscriptTurns(transcript.slice(0, TRANSCRIPT_CAP));
  return turns.some((t) => t.speaker === "user" && SMS_DECLINE_PATTERNS.some((p) => p.test(t.text)));
}

// ── Callback-request lexicon (VOZ-127, 2026-07-15) ──────────────────────────
// A REACHED human asking to be contacted again later ("call me tomorrow", "ring
// me this afternoon", "I'm busy, call later") must be RE-DIALED, not dropped as
// not_interested. The end-of-call webhook treats a match like the voicemail
// skip: it leaves the number at outcome='in_progress' so the scheduler sweeper
// resolves it to pending_retry under the SAME max_attempts cap + retry window
// (no new retry mechanism, no migration).
//
// User turns only (speaker-aware, like customerDeclinedSms) + guarded:
//   • CALLBACK_OPTOUT_GUARD drops opt-out framing ("don't call me again",
//     "stop calling") — that is DNC / not-interested, NEVER a callback.
//   • CALLBACK_CALLER_IS_CUSTOMER drops the customer offering to ring US
//     ("I'll call you later") — only the ambiguous bare "call later" needs it;
//     the "call me …" shapes are unambiguous and matched directly.
// "try again later" is deliberately absent — it is voicemail-greeting
// boilerplate (see VOICEMAIL_* above) and voicemail already routes to retry.
const CALLBACK_LATER_CUE =
  "later|again later|tomorrow|tonight|this (?:afternoon|evening|morning)|some other time|another time|next (?:week|time|month|day)|in (?:an? (?:hour|bit|while|sec|second|minute|moment)|a (?:few|couple)|the (?:morning|afternoon|evening))|after (?:lunch|work|a bit|\\d)|when i'?m (?:free|back|done|available|less busy|not busy)";

// Unambiguous asks — the customer names US as the caller ("me"/"us") or asks
// for a call ("give me a call"). Matched directly (opt-out guard only).
const CALLBACK_DIRECT_PATTERNS: RegExp[] = [
  /\b(?:call|ring|phone|buzz)\s+(?:me|us)?\s*back\b/i, // call me back / call back / ring us back
  new RegExp(
    `\\b(?:call|ring|phone|buzz)\\s+(?:me|us)\\b[^.?!]{0,20}\\b(?:${CALLBACK_LATER_CUE})\\b`,
    "i",
  ), // call me tomorrow / ring me this afternoon / call me some other time
  /\bgive me a (?:call|ring|buzz)\b/i, // give me a call/ring (later)
];

// Bare "call later" with no me/us/back — a callback ask ("I'm busy, call later")
// UNLESS the customer is the one offering to call ("I'll call you later").
const CALLBACK_BARE_LATER = new RegExp(
  `\\b(?:call|ring|phone|buzz)\\b[^.?!]{0,12}\\b(?:${CALLBACK_LATER_CUE})\\b`,
  "i",
);
const CALLBACK_CALLER_IS_CUSTOMER =
  /\b(?:i'?ll|i will|i'?d|i can|i could|i might|let me|we'?ll|we will)\b[^.?!]{0,12}\b(?:call|ring|phone|buzz|get back)\b/i;

// Opt-out / refusal framing — must NEVER read as a callback (it is DNC).
const CALLBACK_OPTOUT_GUARD =
  /\b(?:don'?t|do not|never|stop|quit|no need to|no more)\b[^.?!]{0,15}\b(?:call|ring|phone|contact|calling)\b/i;

/**
 * Did the CUSTOMER ask to be called back later? User turns only, opt-out- and
 * caller-guarded (see lexicon notes above). Conservative (false) on label-less
 * transcripts — no `user` turn to attribute the request to.
 */
export function customerRequestedCallback(transcript: string | null | undefined): boolean {
  if (!transcript) return false;
  const turns = parseTranscriptTurns(transcript.slice(0, TRANSCRIPT_CAP));
  return turns.some((t) => {
    if (t.speaker !== "user") return false;
    const s = t.text;
    if (CALLBACK_OPTOUT_GUARD.test(s)) return false; // "don't call me again" — DNC, not a callback
    if (CALLBACK_DIRECT_PATTERNS.some((p) => p.test(s))) return true;
    return CALLBACK_BARE_LATER.test(s) && !CALLBACK_CALLER_IS_CUSTOMER.test(s);
  });
}

// ── #5 (2026-06-08): machine "hold / leave-a-message / IVR" greetings ───────────
// Phrases a live customer never utters on a cold sales call, which slipped the voicemail
// tiers above and surfaced as fake "real conversations" in /reviews (campaign
// L7_CA_..._05/06) + leaked into golden set v1 (the judge abstained on them).
// ⚠️ 2026-08-13: the "dispatch is protected anyway" half of the reasoning below expired
// when optin_reached_only made the voicemail LABEL the dispatch trigger — the screener
// scripts measured leaking texts now ALSO live in VOICEMAIL_STRONG_HUMAN_PLAUSIBLE_PATTERNS
// (substring, so STT turn-splits can't dodge them). This list stays for the broader
// hold/IVR fragments that are only safe under its every-turn rule. Used ONLY by
// hasRealConversation (the eval surfaces: /reviews, QA candidate, golden freeze) — deliberately
// NOT by isVoicemail, so the call-path goal_reached veto + the SMS consent gate stay untouched
// (the webhook already resolves these to goal_reached=false via hasGenuineCustomerConsent, so it
// needs no change). "try again later" is EXCLUDED — a real brush-off ("call me later") says it.
const MACHINE_GREETING_PATTERNS = [
  /stay on the line/i,
  /record (?:your |a )?messages?\b/i,
  /\bno more room\b/i,
  /you (?:can|may) hang up\b/i,
  /for more options\b/i,
  /\bpress (?:pound|hash|star|one|two|three|four|five|six|seven|eight|nine|the \w+ key)\b/i,
];
function isMachineGreetingTurn(text: string): boolean {
  return MACHINE_GREETING_PATTERNS.some((p) => p.test(text));
}
// True only when EVERY substantive user turn is a machine greeting — FP-safe + turn-aware
// (mirrors allUserTurnsAreMachineFragments). A real human always emits >=1 genuine turn, so this
// cannot fire on a real conversation that merely contains a hold phrase. No labelled user turns
// => treat the whole string as the sole candidate.
function allUserTurnsAreMachineGreetings(transcript: string): boolean {
  const turns = parseTranscriptTurns(transcript);
  const userTurns = turns.filter((t) => t.speaker === "user").map((t) => t.text);
  const candidates = userTurns.length ? userTurns : [transcript.trim()];
  return candidates.length > 0 && candidates.every(isMachineGreetingTurn);
}

/**
 * The Reviews-queue inclusion rule (confirmed with Jasiel 2026-06-02):
 * keep a call iff there was a REAL conversation with the customer —
 *   • at least one substantive customer (user) turn,
 *   • NOT a voicemail greeting (isVoicemail) or a machine hold/IVR greeting (#5),
 *   • NOT just the AI's opening line (which yields zero user turns).
 * Goal-reached is irrelevant here; an unconverted-but-real conversation stays.
 */
export function hasRealConversation(transcript: string | null | undefined): boolean {
  if (!transcript || !transcript.trim()) return false;
  if (isVoicemail(transcript)) return false;
  if (allUserTurnsAreMachineGreetings(transcript)) return false; // #5 — eval surfaces only
  const turns = parseTranscriptTurns(transcript);
  return turns.some((t) => t.speaker === "user" && t.text.trim().length >= 2);
}

/** Count of substantive CUSTOMER (user) turns — a `user` turn with >=2 non-space chars.
 *  Engagement signal for the proxy attempt-tagger: 0 ⇒ no real conversation; <=1 with a
 *  customer-ended-call ⇒ pickup-and-bail. Reuses parseTranscriptTurns. */
export function substantiveUserTurnCount(transcript: string | null | undefined): number {
  if (!transcript || !transcript.trim()) return 0;
  return parseTranscriptTurns(transcript).filter(
    (t) => t.speaker === "user" && t.text.trim().length >= 2,
  ).length;
}
