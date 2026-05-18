-- Dashboard Rebuild Phase 1 — additive schema migration
-- Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §6
-- Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §1
--
-- Adds:
--   campaigns_v2.campaign_type       text     'fixed' | 'recurring' (default 'fixed')
--   campaigns_v2.base_assistant_id   text     populated by clone-assistant step (Phase 1 Step 2)
--   campaigns_v2.parent_campaign_id  uuid     recurring child → parent linkage
--   campaigns_v2.recurrence_pattern  jsonb    Outlook-style schedule definition
--   campaigns_v2.last_resumed_at     timestamptz  analytics + diff base on resume
--
-- Modifies:
--   campaigns_v2.status check         adds 'inactive' (ejected; slot released, history preserved)
--   campaign_numbers_v2.outcome check adds 'removed_from_segment', 'recently_called_elsewhere'
--
-- Indexes:
--   idx_campaigns_v2_parent          partial, parent_campaign_id IS NOT NULL
--   idx_campaigns_v2_type_status     composite (campaign_type, status)
--
-- Run this in the Supabase SQL Editor against STAGING first. Verify on
-- staging before applying to prod; prod application is gated on the Phase 1
-- PR greenlight per the no-prod-commit-without-Chris rule.
--
-- Non-destructive: all column adds are nullable or carry a safe DEFAULT; the
-- CHECK constraint changes only widen the allowed-value set, so existing
-- rows remain valid. The whole migration runs in a single transaction.

begin;

-- ── 1. campaigns_v2: new columns ───────────────────────────────────────
alter table campaigns_v2
  add column campaign_type text not null default 'fixed'
    check (campaign_type in ('fixed', 'recurring')),
  add column base_assistant_id text,
  add column parent_campaign_id uuid references campaigns_v2(id) on delete set null,
  add column recurrence_pattern jsonb,
  add column last_resumed_at timestamptz;

-- ── 2. campaigns_v2.status: add 'inactive' ─────────────────────────────
-- Postgres has no in-place CHECK alteration. The constraint was created
-- inline at column-definition time (supabase-migration-campaign-v2.sql:51-52),
-- so its auto-generated name is campaigns_v2_status_check.
alter table campaigns_v2
  drop constraint campaigns_v2_status_check;

alter table campaigns_v2
  add constraint campaigns_v2_status_check
    check (status in ('draft', 'running', 'paused', 'completed', 'archived', 'inactive'));

-- ── 3. campaign_numbers_v2.outcome: add two soft-mark values ───────────
-- Same DROP/ADD pattern. Original constraint at
-- supabase-migration-campaign-v2.sql:75-79.
alter table campaign_numbers_v2
  drop constraint campaign_numbers_v2_outcome_check;

alter table campaign_numbers_v2
  add constraint campaign_numbers_v2_outcome_check
    check (outcome in (
      'pending', 'in_progress', 'unreached', 'pending_retry', 'sent_sms',
      'not_interested', 'declined_offer', 'wrong_number', 'suppressed',
      'removed_from_segment', 'recently_called_elsewhere'
    ));

-- ── 4. Indexes ─────────────────────────────────────────────────────────
-- Partial index — the recurring-child population is small relative to the
-- whole table, so a partial index keeps writes cheap on Fixed campaigns.
create index idx_campaigns_v2_parent on campaigns_v2(parent_campaign_id)
  where parent_campaign_id is not null;

-- Composite — serves scheduler lookups like
--   WHERE campaign_type = 'recurring' AND status = 'running'
-- and recurring-children-of-parent listings. The existing
-- idx_campaigns_v2_status (campaign-v2.sql:59) stays in place; it still
-- serves status-only queries more efficiently than the composite.
create index idx_campaigns_v2_type_status on campaigns_v2(campaign_type, status);

commit;

-- ── Rollback (manual; uncomment and run in a single transaction) ───────
-- begin;
--
-- drop index if exists idx_campaigns_v2_type_status;
-- drop index if exists idx_campaigns_v2_parent;
--
-- alter table campaign_numbers_v2
--   drop constraint campaign_numbers_v2_outcome_check;
-- alter table campaign_numbers_v2
--   add constraint campaign_numbers_v2_outcome_check
--     check (outcome in (
--       'pending', 'in_progress', 'unreached', 'pending_retry', 'sent_sms',
--       'not_interested', 'declined_offer', 'wrong_number', 'suppressed'
--     ));
--
-- alter table campaigns_v2
--   drop constraint campaigns_v2_status_check;
-- alter table campaigns_v2
--   add constraint campaigns_v2_status_check
--     check (status in ('draft', 'running', 'paused', 'completed', 'archived'));
--
-- alter table campaigns_v2
--   drop column if exists last_resumed_at,
--   drop column if exists recurrence_pattern,
--   drop column if exists parent_campaign_id,
--   drop column if exists base_assistant_id,
--   drop column if exists campaign_type;
--
-- commit;
