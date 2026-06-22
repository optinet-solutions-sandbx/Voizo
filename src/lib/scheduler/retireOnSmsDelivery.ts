// Retire a retrying number once its offer SMS is DELIVERED (cost optimisation, 2026-06-22).
//
// In registered_optin campaigns a voicemail pickup still gets the offer text (the link IS
// the deliverable — see smsDispatchDecision.ts), but the number is deliberately parked at
// outcome='pending_retry' so the dialer keeps trying to reach a live human. findNextNumber
// never consults SMS state, so a number that already received the offer by text still burns
// up to max_attempts more calls (SquareTalk + Vapi per-minute) for ~zero marginal value.
//
// This decides, per number, whether the offer has landed and the retries should stop.
// Scope is voicemail-only BY CONSTRUCTION: a reached human is already terminal (sent_sms),
// so only voicemail hits sit at pending_retry. We require status='delivered' (carrier
// confirmation), never 'sent' — a 'sent' SMS may silently fail, and stopping on it would
// abandon the participant. Numbers on routes that never report DLRs simply keep retrying
// as before (no regression).
//
// Pure + side-effect-free (no mutation, no supabase, no Date.now) so it unit-tests in
// isolation; the campaign-scheduler cron does the I/O and feeds it the inputs.

export interface RetireForSmsDeliveryInput {
  /** campaign_numbers_v2.outcome for this number. */
  outcome: string | null;
  /** statuses of this number's sms_messages_v2 rows (e.g. ["sent","delivered"]). */
  smsStatuses: string[];
}

export function shouldRetireForSmsDelivery(input: RetireForSmsDeliveryInput): boolean {
  return input.outcome === "pending_retry" && input.smsStatuses.includes("delivered");
}
