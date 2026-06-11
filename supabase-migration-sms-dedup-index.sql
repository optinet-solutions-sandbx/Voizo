-- 2026-06-12 — DB-level enforcement of the per-player SMS dedup (voicemail
-- follow-up review, OQ3). ONE non-failed SMS per campaign_number, enforced by
-- a partial unique index — closes the concurrent-webhook race the application
-- check can't (TOCTOU). The webhook treats an insert conflict as "already
-- texted" and skips the send (never sends an untracked SMS).
--
-- PRE-CHECK (must return 0 rows before applying; if any appear, resolve first):
--   select campaign_number_id, count(*)
--   from sms_messages_v2
--   where status <> 'failed'
--   group by 1 having count(*) > 1;

create unique index if not exists uniq_sms_per_campaign_number
  on sms_messages_v2 (campaign_number_id)
  where status <> 'failed';

-- Verify:
--   select indexname from pg_indexes where tablename = 'sms_messages_v2';
