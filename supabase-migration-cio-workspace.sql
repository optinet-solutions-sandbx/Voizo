-- ============================================================================
-- VOZ-198 — Multi-workspace CIO: campaigns_v2.cio_workspace
-- Plan: docs/2026-07-24_PLAN_VOZ-198_Multi_Workspace_CIO.md
-- Spec lineage: docs/2026-07-21_SPEC_CustomerIO_Webhook_Ingress.md §8 / §10 Phase 3
--
-- Why: Customer.io segment ids are only unique PER WORKSPACE. With Fortune Play
-- (workspace #2) arriving, the webhook must route deliveries by
-- (workspace, segment_id) and every App API read must use that workspace's own
-- key. This column is the routing anchor: NULL = legacy = 'lucky7even'.
--
-- ⚠️ Apply BEFORE deploying the VOZ-198 code: the duplicate / refresh-segment /
-- resume / resume-diff routes and the webhook route SELECT this column
-- explicitly — deploying first would 500 those routes until this is applied.
-- (Reads via select("*") — cron poll, campaign-scheduler — are order-safe.)
--
-- Apply to: voizo-sandbox first, then prod (house convention).
-- ============================================================================

alter table public.campaigns_v2
  add column if not exists cio_workspace text;

-- Backfill: every pre-VOZ-198 campaign belongs to the original workspace.
-- Code also treats NULL as 'lucky7even' (belt and braces for rows created by
-- an old deploy in the window between this migration and the code deploy).
update public.campaigns_v2
  set cio_workspace = 'lucky7even'
  where cio_workspace is null;

-- Rollback (manual, if ever needed):
-- alter table public.campaigns_v2 drop column if exists cio_workspace;
