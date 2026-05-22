-- Dashboard Rebuild Phase 1j — Index on local_segments.source_campaign_id
-- Task:   .agent/tasks/2026-05-22_TASK_Dashboard_UI_Polish_And_Workers_Interactivity.md (A8)
-- Date:   2026-05-22
-- Depends on:  1f-audience-segments.sql (the local_segments table)
--
-- The audience-suggestions RPC's NOT EXISTS subquery dedups source
-- campaigns that already have a committed segment:
--
--   and not exists (
--     select 1 from public.local_segments s
--      where s.source_campaign_id = c.id
--   )
--
-- Without an index on source_campaign_id this becomes a full table scan
-- per candidate campaign. At PoC scale (~3 dozen segments) the cost is
-- microseconds, but at production scale (hundreds of segments × ~all
-- finished campaigns scanned every poll) it becomes the dominant cost.
-- Adding the index now prevents a future regression — operators won't
-- feel a slowdown when their segment library grows.
--
-- IF NOT EXISTS so re-running on a fresh DB is safe. Non-destructive.

create index if not exists idx_local_segments_source_campaign
  on public.local_segments(source_campaign_id);

-- ── Verification (run after applying) ───────────────────────────────────
-- Confirm the index exists:
--
--   select indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public' and tablename = 'local_segments';
--
-- The new index should appear as idx_local_segments_source_campaign.
-- Re-run the suggestions RPC and confirm it still returns the same
-- rows — index changes shouldn't affect output, only performance.
