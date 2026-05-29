-- Atomic idempotency guard for recurring child-spawn (audit 2026-05-29 F3).
--
-- The scheduler's per-day idempotency was a non-atomic SELECT-then-INSERT: two
-- overlapping cron ticks could both pass the existence check and both INSERT a
-- child for the same day -> double clone/lease/dial/SMS. Two same-day spawns
-- compute an IDENTICAL start_at (isoForLocalTime(todayStr, hours.start, tz)),
-- so this partial UNIQUE index makes the second INSERT fail at the DB (23505),
-- which spawnChildIfDue now catches + cleans up. Non-recurring rows have
-- parent_campaign_id = NULL (distinct under a unique index) and are unaffected.
--
-- Apply to voizo-sandbox (staging) FIRST, confirm, then voizo-eight (prod).
--
-- PRE-CHECK (run BEFORE creating the index — it fails if duplicates exist):
--   SELECT parent_campaign_id, start_at, count(*)
--   FROM public.campaigns_v2
--   WHERE parent_campaign_id IS NOT NULL
--   GROUP BY 1, 2 HAVING count(*) > 1;
-- Expect 0 rows. If any, dedup those children manually first.

create unique index if not exists uq_campaigns_v2_recurring_child_per_day
  on public.campaigns_v2 (parent_campaign_id, start_at)
  where parent_campaign_id is not null;
