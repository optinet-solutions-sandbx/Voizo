-- Voicemail auto-hangup opt-in flag (2026-07-07)
-- Spec: docs/2026-07-07_DOC_Voicemail_Autohangup_LiveClassifier_Spec.md
--
-- Per-campaign gate for the live kill path in /api/webhooks/vapi/end-of-call:
-- when TRUE, a final customer utterance that is conclusively a voicemail
-- greeting (isConclusiveVoicemail) ends the call via Vapi Live Call Control
-- instead of letting the agent pitch ~27s into the machine.
--
-- Default FALSE: no campaign changes behavior until an operator opts it in.
-- Recurring children do NOT inherit the parent's flag yet (deliberate trial
-- scope — widen after the single-campaign trial holds).
--
-- Apply via Supabase SQL editor BEFORE deploying the code that reads it
-- (the code fails safe if the column is missing, but apply-first is cleaner).

ALTER TABLE campaigns_v2
  ADD COLUMN IF NOT EXISTS voicemail_autohangup boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN campaigns_v2.voicemail_autohangup IS
  'Opt-in: end calls programmatically (Vapi Live Call Control) when a final customer utterance is conclusively a voicemail greeting. Trial feature 2026-07-07.';
