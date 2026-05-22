-- Dashboard Rebuild Phase 1i — RPC clock-skew clamp + ORDER BY tiebreaker
-- Design: docs/2026-05-22_DOC_Dashboard_UI_Polish_And_Workers_Interactivity.md (A3, A4)
-- Task:   .agent/tasks/2026-05-22_TASK_Dashboard_UI_Polish_And_Workers_Interactivity.md
-- Date:   2026-05-22
-- Depends on:  1h-audience-suggestions-rpc.sql (the function must already exist)
--
-- Two body-only changes to get_audience_suggestions:
--
--   A3 (clock-skew clamp): pending/pending_retry rows whose last_attempted_at
--   is in the future (clock skew on a dialer host) no longer skew the MAX()
--   upward and push a campaign to the top of the sort. NULL stays valid
--   (never-attempted phones still count).
--
--   A4 (deterministic tiebreaker): when multiple campaigns have the same
--   MAX(last_attempted_at) the sort is non-deterministic across polls and
--   the LIMIT 20 selection can flip set membership on each refresh. Adding
--   c.id as a secondary sort key makes the suggestion list stable.
--
-- The RETURNS TABLE shape is unchanged, so CREATE OR REPLACE is safe (no
-- 42P13). Wrapped in a transaction anyway so concurrent callers block on
-- the AccessExclusiveLock rather than seeing an intermediate state.
--
-- Safe to re-run.

begin;

create or replace function public.get_audience_suggestions(
  p_min_candidates int default 5,
  p_max_results    int default 20
)
returns table (
  source_campaign_id   uuid,
  source_campaign_name text,
  source_status        text,
  pending_count        integer,
  pending_retry_count  integer,
  last_dialed_at       timestamptz
)
language sql
stable
as $$
  select
    c.id                                                       as source_campaign_id,
    c.name                                                     as source_campaign_name,
    c.status                                                   as source_status,
    (count(*) filter (where n.outcome = 'pending'))::int       as pending_count,
    (count(*) filter (where n.outcome = 'pending_retry'))::int as pending_retry_count,
    max(n.last_attempted_at)                                   as last_dialed_at
  from public.campaigns_v2 c
  join public.campaign_numbers_v2 n on n.campaign_id = c.id
  where c.status in ('paused', 'completed', 'archived', 'inactive')
    and c.is_test = false
    and not exists (
      select 1 from public.local_segments s
       where s.source_campaign_id = c.id
    )
    and n.outcome in ('pending', 'pending_retry')
    -- A3: clock-skew clamp. NULL preserved so never-attempted phones still
    -- count toward the candidate threshold.
    and (n.last_attempted_at is null or n.last_attempted_at <= now())
  group by c.id, c.name, c.status
  having count(*) >= p_min_candidates
  -- A4: c.id breaks ties so polls return a stable ordering / LIMIT slice.
  order by max(n.last_attempted_at) desc nulls last, c.id
  limit p_max_results;
$$;

commit;

-- ── Smoke test (run after applying) ─────────────────────────────────────────
-- 1. Confirm function still returns the same shape:
--
--    select * from public.get_audience_suggestions() limit 3;
--
-- 2. Determinism check — running twice in a row should return identical
--    source_campaign_id sequences (with A4's c.id tiebreaker):
--
--    select source_campaign_id from public.get_audience_suggestions();
--    select source_campaign_id from public.get_audience_suggestions();
--
-- 3. (Optional) Clock-skew check on staging — insert a synthetic row with
--    a future last_attempted_at and confirm it's excluded:
--
--    -- pick a paused/completed source with at least 5 pending phones,
--    -- INSERT a synthetic phone with last_attempted_at = now() + interval '1 day',
--    -- run get_audience_suggestions() and confirm the source's pending_count
--    -- did NOT increase by 1 (the synthetic row was excluded by the clamp).
--    -- Delete the synthetic row when done.

-- ── Rollback (revert to 1h definition; manual) ──────────────────────────────
-- Re-apply 1h-audience-suggestions-rpc.sql in full.
