-- Dashboard Rebuild Phase 1 — segment_id persistence
-- Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.5, §5.6, §5.7
-- Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §5 step 2
--
-- Adds campaigns_v2.segment_id (integer, nullable) so the operator's
-- customer.io segment choice persists. Today the SegmentImporter component
-- fetches members at create time and passes only the phone list to the
-- parent — the segment identity is lost. Without it, Steps 5 (Duplicate),
-- 6 (Manual segment refresh), and 7 (Resume-diff segment-membership check)
-- have no segment to query against.
--
-- Existing campaigns: voice_id is NULL on the existing rows. Downstream
-- code interprets NULL as "no single source segment, cannot refresh" and
-- 400s the refresh attempt with a friendly message.
--
-- Multi-select imports (SegmentImporter checkbox mode that unions phones
-- from N segments) also store NULL — there is no single segment to point
-- at. Step 6/7 reject refresh on such campaigns.
--
-- The valid segment ID range is not enforced at the DB level; customer.io
-- segment IDs are positive integers and the application validates against
-- the live customer.io segments list. No CHECK constraint needed.
--
-- Non-destructive: ALTER TABLE ADD COLUMN with a nullable integer column
-- does not rewrite the table on Postgres 11+; existing rows pick up NULL
-- without scanning. Safe under in-flight traffic.

begin;

alter table campaigns_v2
  add column segment_id integer;

commit;

-- ── Rollback (manual; uncomment and run if you need to revert) ─────────
-- begin;
-- alter table campaigns_v2
--   drop column if exists segment_id;
-- commit;
