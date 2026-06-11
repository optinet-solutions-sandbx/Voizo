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
//                      Promos" opt-in, Val 2026-06-11): send when the AGENT
//                      announced a text on a live call. goal_reached NOT
//                      required; sms_on_goal_reached_only ignored by the
//                      caller (the mode IS the policy).
//
// ABSOLUTE vetoes in BOTH modes: voicemail, on-call opt-out, and (registered
// mode) an explicit customer "don't text me". A no must always win.

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
  /** agentMentionedSms(transcript) — the agent announced/offered a text. */
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
    | "no_agent_sms_announce"
    | "registered_optin_announce"
    | "goal_not_reached"
    | "no_consent_evidence"
    | "verbal_consent";
}

export function decideSmsDispatch(i: SmsDispatchInput): SmsDispatchDecision {
  if (i.voicemailDetected) return { attempt: false, reason: "voicemail" };
  if (i.optedOut) return { attempt: false, reason: "opted_out_on_call" };

  if (i.mode === "registered_optin") {
    if (i.customerDeclinedSms) return { attempt: false, reason: "customer_declined_sms" };
    if (!i.humanConversation) return { attempt: false, reason: "no_human_conversation" };
    if (!i.agentAnnouncedSms) return { attempt: false, reason: "no_agent_sms_announce" };
    return { attempt: true, reason: "registered_optin_announce" };
  }

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
