-- Dashboard Rebuild Phase 1g — campaigns_v2.is_test
-- Design: docs/2026-05-22_DOC_Audience_Suggestions_MVP.md §5.1
-- Task:   .agent/tasks/2026-05-22_TASK_Audience_Suggestions_MVP.md §1
-- Date:   2026-05-22
--
-- Adds a robust marker for test campaigns. Used by the new
-- /api/audience/suggestions endpoint (Phase 1h) to exclude noise from the
-- suggested-segments worklist. Operator-controllable via a UI toggle that
-- lives in the campaign create wizard (Step 1) and the campaign detail page
-- header (next to Resume/Duplicate). Default false — untouched campaigns
-- stay non-test.
--
-- Backfill: a conservative regex flags 14 of 17 currently-known test
-- campaigns in prod with zero false positives. Operator flips the 3 missed
-- ones manually via the UI. Catalog of what gets flagged + what's left for
-- manual review is in the dry-run SELECT comment block below — run that
-- against the target Supabase project FIRST to eyeball the matched set.
--
-- Additive only. No row drops, no FK changes, no enum modifications.
-- Backfill runs in the same transaction so the column is never visible
-- without backfill data applied. Safe to re-run via the IF NOT EXISTS guard.
--
-- Run against STAGING (voizo-sandbox) first. Prod (voizo-eight) waits on
-- Chris's sign-off per memory/feedback_no_prod_commit_without_chris.md.

begin;

-- ── 1. Add column ──────────────────────────────────────────────────────────
alter table public.campaigns_v2
  add column if not exists is_test boolean not null default false;

-- ── 2. Backfill (idempotent — re-runnable) ─────────────────────────────────
-- Patterns derived from observed prod campaign names. Anchored at start of
-- name so legitimate campaigns containing "test" mid-string aren't flagged.
--
--   ^TEST[\s_-]     matches: TEST VOICE A, TEST CALL 1505, TEST 4 ERNIE EVA, etc.
--   ^FINAL TEST     matches: FINAL TEST MARIAs PROMPT, FINAL TEST WITH ...
--   ^TESTERN        matches: TESTERN UPLOAD, TESTERN JACKSON 1405
--
-- Not matched (operator flips manually):
--   "Test Eva and Maria, new opening"      (lowercase Test)
--   "VERY LAST TEST GISELA"                (TEST mid-string)
--   "LAST TEST GEORGE ERNIE 1405"          (TEST mid-string)
update public.campaigns_v2
   set is_test = true
 where is_test = false
   and (name ~* '^TEST[\s_-]'
        or name ~* '^FINAL TEST'
        or name ~* '^TESTERN');

commit;

-- ── Dry-run validation (run BEFORE applying the UPDATE above) ──────────────
-- Paste this in the Supabase SQL editor first. Eyeball the matched set.
-- If anything looks like a real campaign that shouldn't get flagged, refine
-- the regex BEFORE committing the UPDATE.
--
-- select id, name, status from campaigns_v2
--  where name ~* '^TEST[\s_-]' or name ~* '^FINAL TEST' or name ~* '^TESTERN'
--  order by name;

-- ── Post-apply verification ────────────────────────────────────────────────
-- Confirm the backfill landed as expected:
--
-- select count(*) filter (where is_test = true)  as test_count,
--        count(*) filter (where is_test = false) as real_count,
--        count(*)                                 as total
--   from campaigns_v2;
--
-- Expected on prod (current ~60 campaigns): test_count ~14, real_count ~46.

-- ── Rollback (manual; uncomment and run if needed) ─────────────────────────
-- begin;
-- alter table public.campaigns_v2 drop column if exists is_test;
-- commit;
