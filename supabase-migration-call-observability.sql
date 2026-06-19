-- Call-observability persistence — additive migration
-- Spec: docs/2026-06-19_SPEC_call-observability-persistence.md
--
-- Adds three nullable columns to calls_v2, each persisting a "why did the call end" signal that
-- the webhooks ALREADY receive but currently discard:
--   hangup_cause  text     raw FreeSWITCH hangup cause (carrier/outbound leg) — written by
--                          /api/webhooks/freeswitch/voice-status from payload.hangup_cause, which
--                          mapHangup() currently collapses into `status` and throws away.
--   ended_reason  text     Vapi's endedReason verbatim (AI-conversation leg) — written by
--                          /api/webhooks/vapi/end-of-call (today it is only console.log'd).
--   voicemail     boolean  transcript-detected voicemail (voicemailDetected via isVoicemail) —
--                          written by /api/webhooks/vapi/end-of-call (today only used to gate the
--                          outcome-skip; never persisted → voicemail rate is structurally 0).
--
-- Why: turns "why did calls fail / what is our voicemail rate" from a deep DB/SSH probe into a
-- dashboard glance (FreeSWITCH audit + AU-CID analysis + P3-S2 all pointed here).
--
-- Non-destructive: all nullable, no default, no backfill. Historical rows stay NULL ("not captured
-- before the migration date" — same honesty as recording_url). Causes are NOT recoverable
-- retroactively (providers do not resend) → forward-only.
--
-- RLS: a column add inherits calls_v2's existing RLS; no policy change. Reads stay on the
-- auth-gated service-role routes.
--
-- *** DEPLOY ORDER (critical) ***
-- Apply THIS migration to prod FIRST and confirm the columns exist, THEN deploy the webhook code
-- that writes them. If the code ships first, the webhook UPDATE references a missing column and
-- FAILS — and on the FreeSWITCH handler that breaks chain-next dialing. Apply to voizo-sandbox
-- (the one prod DB — there is NO separate staging) after the no-prod-change-without-Chris check.

begin;

alter table calls_v2
  add column hangup_cause text,
  add column ended_reason text,
  add column voicemail    boolean;

commit;

-- ── Rollback (single transaction; only if no readers have started using them) ──
-- begin;
--   alter table calls_v2
--     drop column hangup_cause,
--     drop column ended_reason,
--     drop column voicemail;
-- commit;
