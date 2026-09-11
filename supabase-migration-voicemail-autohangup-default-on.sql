-- Voicemail auto-hangup becomes the default (2026-09-11)
--
-- Supersedes the `DEFAULT false` set by supabase-migration-voicemail-autohangup.sql (2026-07-07),
-- which was deliberately opt-in so the feature could ship behaviour-neutral during its trial.
-- The trial is over; keep that file as-is for history and apply this one after it.
--
-- WHY
--   The flag was never a per-campaign choice in practice: there is no control for it in the
--   campaign wizard, so every campaign is created with the database default and the only way it
--   ever got switched on was a one-off maintenance script. Two scripts ran (2026-08-14 and
--   2026-08-24); every campaign created after 2026-08-24 was therefore silently OFF, including
--   Roosterbet AU (off for two weeks) and the three campaigns built on 2026-09-10.
--   A setting that touches spend and call behaviour must not depend on someone remembering a script.
--
-- WHAT THE EVIDENCE SAYS (measured 2026-09-11, scripts/_diag-0911-vm-autohangup-*.cjs)
--   SAFE. The kill tier (isConclusiveVoicemail) matches only machine-exclusive phrases; phrases a
--   live human could plausibly say label the call but never hang up. Measured false-positive rate
--   was LOWER with the flag on: 1 of 1,179 (0.1%) vs 19 of 3,121 (0.6%) with it off.
--   IT DOES FIRE. Like-for-like on NZ, 11 Sep, same night and script: ended_reason
--   `assistant-ended-call-after-message-spoken` equals the killable-phrase count exactly on both
--   flag-ON lanes (32 and 5) and appears zero times on the flag-OFF lane (0 of 548).
--   BUT IT SAVES LITTLE. ~1.8s per voicemail (16.2s -> 14.4s), roughly 5% of voicemail minutes,
--   because the trigger phrase only arrives ~14s into a greeting. The >60s tail is not improved.
--   This change is for CONSISTENCY, not cost. Do not quote it as a saving.
--
-- SCOPE
--   Statement 1 affects NEW rows only. Statement 2 covers what was live or about to go live on
--   2026-09-11 (4 running recurring parents + 2 draft daily children); ~65 dead May-Jul campaigns
--   sit at paused/inactive and are deliberately left alone. Recurring children copy the parent's
--   value at spawn (lib/scheduler/recurringSpawn.ts), so the parents are what matter going forward.
--
-- APPLIED TO PRODUCTION 2026-09-11 ~12:55 UTC (Supabase SQL editor). Verified afterwards: the live
-- column default reads true, and zero running/draft campaigns remain off.

ALTER TABLE campaigns_v2
  ALTER COLUMN voicemail_autohangup SET DEFAULT true;

UPDATE campaigns_v2
   SET voicemail_autohangup = true
 WHERE voicemail_autohangup = false
   AND status IN ('running', 'draft')
   AND is_test IS NOT TRUE;

COMMENT ON COLUMN campaigns_v2.voicemail_autohangup IS
  'End calls via Vapi Live Call Control when a final customer utterance is conclusively a voicemail greeting. Default TRUE since 2026-09-11; recurring children inherit the parent at spawn.';
