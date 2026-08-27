// smsDispatchDecision — PURE mode-aware SMS dispatch policy (2026-06-11).
//
// Extracted so the end-of-call webhook's irreversible action (sending a text)
// is decided by a unit-testable function instead of inline conditions. The
// route computes the input flags (transcript classifiers, Vapi analysis) and
// acts on `attempt`; the suppression_list check stays in the route at send
// time (DB lookup, not a pure input).
//
// Modes (campaigns_v2.sms_consent_mode):
//   verbal_yes       — today's behavior, verbatim: goal_reached AND consent
//                      evidence (Vapi native success OR a genuine customer yes).
//   registered_optin — client-owned consent basis (registration "Receive SMS
//                      Promos" opt-in, Val 2026-06-11): send to EVERY reached
//                      contact — any live human we actually spoke to, and a
//                      missed-call follow-up on voicemail pickups. goal_reached
//                      NOT required; sms_on_goal_reached_only ignored by the
//                      caller (the mode IS the policy). The agent announcing a
//                      text on the call is NO LONGER required (Ernie ticket,
//                      Val approved 2026-06-16): consent is the signup opt-in,
//                      not the call, and agents announced on only ~5% of live
//                      calls — gating on it dropped texts to nearly everyone.
//
// ABSOLUTE veto in BOTH modes: on-call opt-out — a "stop calling" must always win.
// Voicemail vetoes in verbal_yes only; in registered_optin a voicemail pickup TRIGGERS the
// missed-call follow-up text instead (client-agreed 2026-06-11). An explicit customer "don't
// text me" (customerDeclinedSms) still vetoes a registered_optin LIVE-human send — but it is
// checked AFTER the voicemail follow-up (2026-06-25 fix): the decline classifier false-positives
// on machine greetings ("No message can be left…"), and a voicemail has no human to genuinely
// decline, so the follow-up wins.

//   optin_any_pickup — VOZ-245 (Val, 2026-07-28). Same consent basis as
//                      registered_optin (the registration "Receive SMS Promos"
//                      tick), but a LOWER trigger bar: every answered line gets
//                      the one text regardless of how the conversation went.
//                      Sluggish, incomprehensible, early hang-up and
//                      answered-in-silence all count as reached — conversation
//                      quality is not a consent signal, and the offer link IS
//                      the payload. In other words: registered_optin minus the
//                      humanConversation gate.
//
//                      Why the gate was safe to drop: it existed (review H3) to
//                      stop an agent monologuing into an UNDETECTED machine from
//                      arming a text — but this mode already texts DETECTED
//                      voicemail as a missed-call follow-up, so the gate was
//                      blocking the ambiguous cases while the certain ones went
//                      through. Either way the text lands on the number the CRM
//                      gave us for that player.
//
//                      Measured on the 2026-07-27/28 realtime run: verbal_yes
//                      sent 6 (of 14 real humans who had heard the SMS offer),
//                      registered_optin would send 201, this mode 230.
//   optin_reached_only — Val, 2026-08-07 (relayed + confirmed by Jasiel): text
//                      everyone we GENUINELY talk to and nobody else. Same
//                      consent basis as the other opt-in modes (registration
//                      "Receive SMS Promos"), but the trigger is the DASHBOARD's
//                      own attempt tag: positive / neutral / declined get the
//                      text; voicemail, early hang-up (dead-air pickup), agent
//                      timeout (pipeline death — we owe a redial, not a text)
//                      and unreached never do. Two deliberate departures from
//                      the older opt-in modes, both Val's explicit calls:
//                        • an on-call SMS refusal does NOT veto (literal-Val
//                          rule, Jasiel chose it over promote-emphatic-to-DNC
//                          2026-08-07) — only the "stop calling" opt-out does;
//                        • no voicemail follow-up and NO last-resort text
//                          ("never text someone we didn't reach").
//                      Reusing deriveAttemptTag as the trigger is the invariant
//                      Val asked for after finding texted players hiding under
//                      the Early hang-up filter: dispatch and the SMS card's
//                      sub-rows share one classifier, so no SMS can ever appear
//                      under a bucket this mode refuses to text.
/** The dashboard's per-attempt tag (dashboardAnalytics.deriveAttemptTag) — the
 *  optin_reached_only trigger signal. Type-only import: no runtime dependency. */
import type { AttemptTag } from "./dashboardAnalytics";

export type SmsConsentMode = "verbal_yes" | "registered_optin" | "optin_any_pickup" | "optin_reached_only";

export interface SmsDispatchInput {
  mode: SmsConsentMode;
  goalReached: boolean;
  /** Vapi native successEvaluation === true (rare on SIP traffic). */
  nativeSuccess: boolean;
  voicemailDetected: boolean;
  /** Customer opted out of CALLS on this call (structuredData or transcript fallback). */
  optedOut: boolean;
  /** hasGenuineCustomerConsent(transcript) — speaker-aware customer yes. */
  hasVerbalConsent: boolean;
  /** agentMentionedSms(transcript) — did the agent announce/offer a text on the call.
   *  NOTE (2026-06-16): no longer gates registered_optin dispatch (Val approved removing the
   *  announce requirement — see header). Kept on the input for reversibility and as an available
   *  observability signal (the webhook still computes & passes it); the decision now ignores it. */
  agentAnnouncedSms: boolean;
  /** customerDeclinedSms(transcript) — explicit, text-directed refusal. */
  customerDeclinedSms: boolean;
  /** hasRealConversation(transcript) — a real human actually spoke (review H3:
   *  without this, an agent monologue into an undetected machine arms dispatch). */
  humanConversation: boolean;
  /** VOZ-132 §8 (2026-07-10): campaign has sms_last_resort_template set —
   *  the text becomes a LAST resort, so a mode-2 voicemail re-dials instead of
   *  texting instantly; the one text goes out only after the final failed try
   *  (scheduler last-resort sweep). OPTIONAL so the flag's absence (every
   *  pre-existing caller/campaign) preserves today's behavior byte-for-byte. */
  lastResortMode?: boolean;
  /** deriveAttemptTag for THIS call (optin_reached_only's trigger). Computed by
   *  the webhook from the same fields the dashboard reads, so dispatch can never
   *  disagree with the card/drawer bucket. Optional because the older modes
   *  don't consume it; when optin_reached_only sees it missing, it fails SAFE
   *  (no text) rather than guessing. */
  attemptTag?: AttemptTag;
}

export interface SmsDispatchDecision {
  attempt: boolean;
  /** Stable machine-readable reason for logs/observability. */
  reason:
    | "voicemail"
    | "opted_out_on_call"
    | "customer_declined_sms"
    | "no_human_conversation"
    | "registered_optin_reached"
    /** optin_any_pickup (VOZ-245): answered line, no veto — distinct from
     *  registered_optin_reached so logs show WHICH bar the send cleared. */
    | "any_pickup_reached"
    | "registered_optin_voicemail_followup"
    | "voicemail_redial_first"
    | "goal_not_reached"
    | "no_consent_evidence"
    | "verbal_consent"
    /** optin_reached_only outcomes (Val 2026-08-07) — one reason per refused
     *  dashboard bucket so logs show exactly WHICH bucket blocked the text. */
    | "early_hangup"
    | "agent_timeout"
    /** silent_pickup (2026-08-13): the line answered but nobody ever spoke — zero
     *  substantive user turns. Zero human evidence never gets a text. */
    | "silent_pickup"
    | "not_reached"
    | "reached_engaged";
}

/**
 * Map the raw `campaigns_v2.sms_consent_mode` column to a mode. Unknown, NULL and
 * pre-migration values fall back to `verbal_yes` — the most-gated policy, so a
 * bad read can never widen dispatch.
 *
 * This is deliberately the ONLY place the column is interpreted (VOZ-245). It
 * used to be an inline ternary duplicated in processEndOfCall and
 * lastResortSweep, which meant adding a third mode silently degraded any caller
 * that hadn't learned about it — the same "consent-mode drift" shape as the
 * 0-SMS incident. One resolver, so a new mode reaches every caller at once.
 */
export function resolveSmsConsentMode(raw: unknown): SmsConsentMode {
  return raw === "registered_optin" || raw === "optin_any_pickup" || raw === "optin_reached_only"
    ? raw
    : "verbal_yes";
}

/** Every value the column accepts, in operator-facing order. Single source for
 *  the API validator and the UI pickers. */
export const SMS_CONSENT_MODES: readonly SmsConsentMode[] = [
  "verbal_yes",
  "registered_optin",
  "optin_any_pickup",
  "optin_reached_only",
];

/** Modes that own a last-resort ("sorry we missed you") text. optin_reached_only
 *  is deliberately absent — Val 2026-08-07: never text someone we didn't reach.
 *  Single source for decideLastResortSend AND the UI's last-resort controls, so
 *  a mode can't qualify for the sweep while hiding the operator switch (or the
 *  reverse). */
export const LAST_RESORT_MODES: readonly SmsConsentMode[] = ["registered_optin", "optin_any_pickup"];

export function modeHasLastResort(mode: SmsConsentMode): boolean {
  return (LAST_RESORT_MODES as readonly string[]).includes(mode);
}

/**
 * WRITE-side counterpart of resolveSmsConsentMode: returns null on anything
 * unknown instead of coercing. Deliberately strict — a read that cannot parse
 * should fall back to the safest policy, but a WRITE that cannot parse is an
 * operator or client bug and must 400 rather than silently store/keep something
 * else. Also keeps a typo from reaching the DB CHECK constraint as a 500.
 */
export function parseSmsConsentMode(raw: unknown): SmsConsentMode | null {
  return typeof raw === "string" && (SMS_CONSENT_MODES as readonly string[]).includes(raw)
    ? (raw as SmsConsentMode)
    : null;
}

export function decideSmsDispatch(i: SmsDispatchInput): SmsDispatchDecision {
  if (i.optedOut) return { attempt: false, reason: "opted_out_on_call" };

  if (i.mode === "optin_reached_only") {
    // A voicemail is never texted in this mode, whatever the tag says (2026-08-27).
    // deriveAttemptTag lets goal_reached beat voicemail (Val 2026-07-03, a DISPLAY
    // rule so a positive contact never shows a non-positive attempt). Vapi's success
    // analysis has read machine greetings as a yes — nine texts went to a machine
    // that said only "Message.", four to "...will send the message as a text" — and
    // a "positive" tag is textable. The webhook already drops goal_reached when the
    // classifier says voicemail, so today this line is unreachable; it is here so
    // the policy holds inside this function and not only in one caller's ordering.
    if (i.voicemailDetected) return { attempt: false, reason: "voicemail" };
    // The dashboard's attempt tag IS the policy (Val 2026-08-07): the three
    // Reached-card sub-buckets that mean a live human engaged get the text —
    // including "declined" and on-call SMS refusals (customerDeclinedSms is
    // deliberately NOT consulted; literal-Val rule, Jasiel 2026-08-07). The
    // opted_out veto above still catches "stop calling".
    switch (i.attemptTag) {
      case "positive":
      case "neutral":
      case "declined":
        return { attempt: true, reason: "reached_engaged" };
      // lastResortMode is deliberately ignored: this mode never defers a
      // voicemail into a later text — it just never texts one.
      case "voicemail":
        return { attempt: false, reason: "voicemail" };
      case "agent_timeout":
        return { attempt: false, reason: "agent_timeout" };
      case "early_hangup":
        return { attempt: false, reason: "early_hangup" };
      // silent_pickup (2026-08-13, Phase A): connected, but zero substantive user
      // turns — dead air or an undetected machine. 316 such calls read 'neutral'
      // (= texted) across the measured window. Zero human evidence, no text.
      case "silent_pickup":
        return { attempt: false, reason: "silent_pickup" };
      default:
        // unreachable — or no tag supplied. A caller that can't say which
        // bucket the call landed in doesn't get to text (fail-safe).
        return { attempt: false, reason: "not_reached" };
    }
  }

  if (i.mode === "registered_optin" || i.mode === "optin_any_pickup") {
    // Missed-call follow-up (2026-06-11 EOD, Jasiel: agreed with Val off-thread, announced in
    // the GC): a voicemail pickup gets the text too — the player opted in at registration and
    // the offer link IS the payload. CHECKED BEFORE customerDeclinedSms (2026-06-25 fix): the
    // SMS-decline classifier false-positives on machine greetings — a "message bank full"
    // voicemail ("No message can be left on this service…") is STT-labeled as a user turn and
    // matches SMS_DECLINE_PATTERNS' /\bno …messages?\b/. A voicemail carries no live human to
    // genuinely decline, so the follow-up takes precedence. (optedOut is still checked first,
    // above — a real "stop calling" must always win.) The announce / human-conversation gates
    // only apply to the live-human path (no announce is possible on a voicemail — prefix rule
    // #4 ends those calls). The per-player dedup in the webhook caps retried voicemails at ONE text.
    if (i.voicemailDetected) {
      // Last-resort mode (VOZ-132 §8): don't text the voicemail — the number
      // rides the normal retry cycle (outcome routing is untouched; the
      // webhook already skips the outcome update for voicemails and the
      // sweeper resolves to pending_retry). The one text goes out after the
      // FINAL failed try via decideLastResortSend below.
      if (i.lastResortMode) return { attempt: false, reason: "voicemail_redial_first" };
      return { attempt: true, reason: "registered_optin_voicemail_followup" };
    }
    if (i.customerDeclinedSms) return { attempt: false, reason: "customer_declined_sms" };
    // optin_any_pickup (VOZ-245) skips this gate: an answered line IS the trigger,
    // so a pickup where nobody spoke (28 such calls in the 07-27/28 run — mostly
    // undetected machines) still gets the text. Jasiel/Val chose "treat as
    // reached, text immediately" over routing them to the last-resort path.
    // NOTE the gate sits BELOW the voicemail branch on purpose in both modes —
    // see the 2026-06-25 ordering note above; hoisting the decline check above
    // voicemail silently dropped ~9 of these texts in simulation.
    if (i.mode === "registered_optin" && !i.humanConversation) {
      return { attempt: false, reason: "no_human_conversation" };
    }
    // 2026-06-16 (Ernie ticket, Val approved): the announce requirement is REMOVED — a reached
    // human (not opted-out, no explicit "don't text me", not suppressed) is texted. Consent is the
    // signup opt-in, not the call; agents announced on only ~5% of live calls, so the old gate
    // dropped texts to nearly every reached human. agentAnnouncedSms stays only as observability.
    return {
      attempt: true,
      reason: i.mode === "optin_any_pickup" ? "any_pickup_reached" : "registered_optin_reached",
    };
  }

  // verbal_yes: voicemail remains an absolute veto (a machine cannot consent).
  if (i.voicemailDetected) return { attempt: false, reason: "voicemail" };

  // verbal_yes — preserves the pre-2026-06-11 dispatch outcomes, with ONE
  // deliberate strengthening (review L1): optedOut now vetoes explicitly here
  // instead of relying on the auto-suppress upsert landing before the
  // suppression check. Same net result when that upsert succeeds; safer when
  // it doesn't. humanConversation is NOT required in this mode — a genuine
  // consent already implies a human (hasGenuineCustomerConsent is speaker-aware).
  if (!i.goalReached) return { attempt: false, reason: "goal_not_reached" };
  if (!(i.nativeSuccess || i.hasVerbalConsent)) return { attempt: false, reason: "no_consent_evidence" };
  return { attempt: true, reason: "verbal_consent" };
}

/**
 * VOZ-132 §8 — should this number receive the ONE "sorry we missed you"
 * last-resort text? Pure predicate; the campaign-scheduler sweep owns the I/O
 * (suppression check, one-text dedup, claim insert, Mobivate send).
 *
 * attemptCount >= maxAttempts is load-bearing beyond the obvious: realtime
 * rollover closes yesterday's uncalled rows as 'unreached' while the player
 * CONTINUES in today's child — those rows are under max by definition and
 * must never trigger a text.
 *
 * campaignStatus running/paused only: a number that exhausts while the
 * campaign is live gets the text; players in operator-stopped or completed
 * campaigns never receive surprise texts later.
 */
export function decideLastResortSend(args: {
  outcome: string;
  attemptCount: number | null;
  maxAttempts: number;
  mode: SmsConsentMode;
  smsEnabled: boolean;
  lastResortTemplate: string | null;
  campaignStatus: string;
}): boolean {
  return (
    args.outcome === "unreached" &&
    (args.attemptCount ?? 0) >= args.maxAttempts &&
    // LAST_RESORT_MODES (VOZ-245): the last-resort text is a property of the
    // registration consent basis, not of the trigger bar — except
    // optin_reached_only, which excludes it on purpose (Val 2026-08-07: never
    // text someone we didn't reach).
    modeHasLastResort(args.mode) &&
    args.smsEnabled &&
    typeof args.lastResortTemplate === "string" &&
    args.lastResortTemplate.trim().length > 0 &&
    (args.campaignStatus === "running" || args.campaignStatus === "paused")
  );
}
