-- Dashboard Rebuild Phase 1 — voice_id persistence
-- Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §4.3
-- Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §4 step 1
--
-- Adds campaigns_v2.voice_id (text, nullable) so the operator's voice
-- choice persists across eject → re-bind. Today the chosen voice exists
-- only on the live Vapi clone; once the clone is deleted on eject, the
-- choice is lost. Re-bind needs voice_id stored on the campaign row.
--
-- Existing campaigns: voice_id is NULL on the existing rows. The re-bind
-- endpoint treats NULL as "use the base agent's default voice" — that's
-- the safe fallback for pre-Step-4 campaigns.
--
-- The valid voice IDs are not enforced at the DB level; they're enforced
-- in clone-assistant via the KNOWN_VOICES allowlist. The DB only stores
-- the string the application persisted.
--
-- Non-destructive: ALTER TABLE ADD COLUMN with a nullable column does
-- not rewrite the table on Postgres 11+; existing rows pick up NULL
-- without scanning. Safe under in-flight traffic.

begin;

alter table campaigns_v2
  add column voice_id text;

commit;

-- ── Rollback (manual; uncomment and run if you need to revert) ─────────
-- begin;
-- alter table campaigns_v2
--   drop column if exists voice_id;
-- commit;
