-- Dashboard Rebuild Phase 1 — follow-up to phase-1 main migration
-- Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §4.3
-- Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §3
--
-- Drops the NOT NULL constraint on campaigns_v2.vapi_assistant_id.
--
-- The original schema (supabase-migration-campaign-v2.sql:29) declared this
-- column NOT NULL, which predates the Eject primitive. Eject deletes the
-- per-campaign Vapi clone and must clear vapi_assistant_id so the campaign
-- row no longer points at a deleted assistant. The NOT NULL constraint
-- blocks that UPDATE with Postgres error 23502.
--
-- Re-bind (Phase 1 Step 4) also depends on this column being nullable —
-- an ejected campaign sits in status='inactive' with NULL pointers until
-- Re-bind re-clones and re-leases.
--
-- The two other pointer columns cleared by Eject (vapi_pool_slot_id,
-- vapi_sip_uri) were added by later migrations and are already nullable;
-- no relaxation needed for those.
--
-- Run on staging Supabase first. This is non-destructive: ALTER COLUMN
-- DROP NOT NULL keeps all existing values intact and only relaxes the
-- constraint check on future writes.

begin;

alter table campaigns_v2
  alter column vapi_assistant_id drop not null;

commit;

-- ── Rollback (manual; uncomment and run if you need to revert) ─────────
-- begin;
--
-- -- Re-applying NOT NULL only works if every row has a non-null value.
-- -- After Eject ships, inactive campaigns will have NULL here, so this
-- -- rollback should not be run while any campaigns_v2 row has
-- -- vapi_assistant_id IS NULL.
-- alter table campaigns_v2
--   alter column vapi_assistant_id set not null;
--
-- commit;
