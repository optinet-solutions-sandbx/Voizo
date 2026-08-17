-- QA analysis — record which model produced each verdict (2026-08-17)
--
-- Adds listener_qa_analysis_runs.scored_by: the model that produced the STORED verdict.
--   'gpt-5.4-mini' — first-pass score (or a fall-back when escalation failed)
--   'gpt-5.4'      — the Early-Hangup/Neutral double-check produced this verdict
-- Lets the dashboard/history show which calls were double-checked (VOZ hybrid scorer).
--
-- Additive + idempotent. Run in the Supabase SQL editor. The app writes it defensively
-- (retries without the column if this migration hasn't been applied yet), so ordering
-- of deploy vs migration is safe.

alter table listener_qa_analysis_runs add column if not exists scored_by text;
