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
// ABSOLUTE vetoes in BOTH modes: on-call opt-out and (registered mode) an
// explicit customer "don't text me" — a no must always win. Voicemail vetoes
// in verbal_yes only; in registered_optin a voicemail pickup TRIGGERS the
// missed-call follow-up text instead (client-agreed 2026-06-11).

export type SmsConsentMode = "verbal_yes" | "registered_optin";

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
    | "registered_optin_voicemail_followup"
    | "goal_not_reached"
    | "no_consent_evidence"
    | "verbal_consent";
}

export function decideSmsDispatch(i: SmsDispatchInput): SmsDispatchDecision {
  if (i.optedOut) return { attempt: false, reason: "opted_out_on_call" };

  if (i.mode === "registered_optin") {
    if (i.customerDeclinedSms) return { attempt: false, reason: "customer_declined_sms" };
    // Missed-call follow-up (2026-06-11 EOD, Jasiel: agreed with Val off-thread,
    // announced in the GC): a voicemail pickup gets the text too — the player
    // opted in at registration and the offer link IS the payload. The announce /
    // human-conversation requirements only apply to the live-human path (no
    // announce is possible on a voicemail — prefix rule #4 ends those calls).
    // The per-player dedup in the webhook caps retried voicemails at ONE text.
    if (i.voicemailDetected) return { attempt: true, reason: "registered_optin_voicemail_followup" };
    if (!i.humanConversation) return { attempt: false, reason: "no_human_conversation" };
    // 2026-06-16 (Ernie ticket, Val approved): the announce requirement is REMOVED — a reached
    // human (not opted-out, no explicit "don't text me", not suppressed) is texted. Consent is the
    // signup opt-in, not the call; agents announced on only ~5% of live calls, so the old gate
    // dropped texts to nearly every reached human. agentAnnouncedSms stays only as observability.
    return { attempt: true, reason: "registered_optin_reached" };
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
