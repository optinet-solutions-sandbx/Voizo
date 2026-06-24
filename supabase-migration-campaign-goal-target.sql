-- Add goal_target column to campaigns_v2.
--
-- Per-campaign, operator-set TARGET count of goal-reached calls — the denominator in the Campaign
-- Performance report's "Campaign goal  X / Y" tile (X = goal_reached calls so far, Y = goal_target).
-- Set manually at campaign creation by the campaign manager; represents the target number of
-- successful outcomes (deposit, callback accepted, etc.) for the campaign.
--
-- Non-destructive: nullable, no default, no backfill. Campaigns created before this migration — and
-- any created without a target — have goal_target = NULL, so the report shows the goal COUNT only,
-- with no "/ Y" denominator. Forward-only.
--
-- CHECK: a target, when set, must be positive (a 0 target is meaningless; NULL = unset is allowed,
-- so clearing back to NULL stays valid). RLS: a column add inherits campaigns_v2's existing RLS;
-- no policy change. IF NOT EXISTS so re-runs on a fresh DB are idempotent.
--
-- Apply to voizo-sandbox (the one prod DB — there is NO separate staging) AFTER the
-- no-prod-change-without-Chris check, and BEFORE deploying the wizard code that writes it.

begin;

alter table campaigns_v2
  add column if not exists goal_target integer;

alter table campaigns_v2
  drop constraint if exists campaigns_v2_goal_target_positive;
alter table campaigns_v2
  add constraint campaigns_v2_goal_target_positive
  check (goal_target is null or goal_target > 0);

commit;

-- ── Rollback (single transaction; only if no readers/writers use it yet) ──
-- begin;
--   alter table campaigns_v2 drop constraint if exists campaigns_v2_goal_target_positive;
--   alter table campaigns_v2 drop column if exists goal_target;
-- commit;
