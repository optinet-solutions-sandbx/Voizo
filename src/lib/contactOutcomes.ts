// Outcome strings on local_segments.contact_outcome that count a phone
// as "already contacted" for segment-membership and duplicate-suppression
// purposes. Used by /api/audience/segments, /api/campaigns-v2/[id]/duplicate,
// /api/campaigns-v2/[id]/resume, /api/campaigns-v2/[id]/resume-diff.
export const CONTACT_OUTCOMES = [
  "sent_sms",
  "not_interested",
  "declined_offer",
  "unreached",
  "pending_retry",
] as const;

export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];
