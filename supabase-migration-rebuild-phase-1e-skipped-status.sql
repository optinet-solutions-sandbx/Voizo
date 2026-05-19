-- Dashboard Rebuild Phase 1 — 'skipped' status for empty-segment recurring spawn
-- Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.5, §9.2 step 7a
-- Plan:   .claude/plans/new-shift-picking-gentle-puffin.md Slice 2
--
-- Widens campaigns_v2.status CHECK to include 'skipped'.
--
-- When a recurring parent has skip_if_empty=true and customer.io returns an
-- empty segment for today's spawn window, the scheduler inserts a child row
-- with status='skipped' as a per-day audit trail. No clone, no slot, no
-- numbers — just a row recording that today was attempted and segment was
-- empty. The next day's spawn re-evaluates the segment freshly.
--
-- The original status CHECK was set by migration 1 at line 47-48; this
-- file follows the same DROP/ADD pattern. The existing six values stay;
-- only 'skipped' is added.
--
-- Non-destructive: existing rows remain valid (the constraint only widens
-- the allowed-value set). Migration runs in a single transaction. The
-- rollback DROP at the bottom only works iff no rows currently hold the
-- new 'skipped' value.
--
-- Run this in the Supabase SQL Editor against STAGING first. Prod apply
-- joins migrations 1, 1b, 1c, 1d on Chris's Phase 1 PR sign-off per the
-- no-prod-commit-without-Chris rule.

begin;

alter table campaigns_v2
  drop constraint campaigns_v2_status_check;

alter table campaigns_v2
  add constraint campaigns_v2_status_check
    check (status in ('draft', 'running', 'paused', 'completed', 'archived', 'inactive', 'skipped'));

commit;

-- ── Rollback (manual; uncomment and run in a single transaction) ───────
-- Only safe if no campaigns_v2 rows currently have status='skipped'.
-- Reverts the CHECK constraint to the post-migration-1 value set.
--
-- begin;
--
-- alter table campaigns_v2
--   drop constraint campaigns_v2_status_check;
--
-- alter table campaigns_v2
--   add constraint campaigns_v2_status_check
--     check (status in ('draft', 'running', 'paused', 'completed', 'archived', 'inactive'));
--
-- commit;
