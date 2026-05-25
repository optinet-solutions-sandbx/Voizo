-- Add last_paused_at column to campaigns_v2.
--
-- Mirrors existing last_resumed_at. Used by all three pause-writers
-- (operator stop, scheduler outside-window, voice-status webhook) to
-- record when a campaign last entered paused state. Useful for:
--   - "how long was this paused before resume?" telemetry
--   - future "auto-archive if paused > 30 days" policy
--
-- Phase 0 of docs/2026-05-25_DOC_SIP_Slot_Release_On_Pause.md.
-- Safe to apply: nullable, no backfill needed. IF NOT EXISTS so
-- re-runs on a fresh DB are idempotent.

alter table campaigns_v2
  add column if not exists last_paused_at timestamptz;
