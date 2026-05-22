-- Dashboard Rebuild Phase 1h — Audience Suggestions RPC
-- Design: docs/2026-05-22_DOC_Audience_Suggestions_MVP.md §5.2
-- Task:   .agent/tasks/2026-05-22_TASK_Audience_Suggestions_MVP.md §5
-- Date:   2026-05-22
-- Depends on:  1g-is-test.sql (the is_test column must exist first)
--
-- Provides the aggregation query that powers GET /api/audience/suggestions.
-- Returns finished campaigns that still have recyclable phones (pending or
-- pending_retry), sorted newest-activity-first. The endpoint just calls this
-- RPC and shapes the response — keeps the aggregation logic in the DB where
-- it belongs.
--
-- Read-only. STABLE function. SECURITY INVOKER (default) — the calling Next.js
-- route uses the service-role connection (supabaseAdmin) which bypasses RLS
-- naturally; we don't need to elevate further inside the function.
--
-- Filter logic:
--   - source status IN ('paused', 'completed', 'archived', 'inactive')
--     (i.e., not currently dialing — race-safe to suggest)
--   - is_test = false (excludes test campaigns; operator-controlled flag)
--   - NOT EXISTS in local_segments (dedup: don't suggest sources that already
--     have a committed segment derived from them)
--   - At least p_min_candidates phones in pending or pending_retry combined
--
-- Sort + limit:
--   - Newest activity first (MAX(last_attempted_at) DESC NULLS LAST)
--   - LIMIT p_max_results to prevent visual flood on /audience
--
-- Safe to re-run (`create or replace function`). Adds nothing to existing
-- schema beyond the function definition.

begin;

-- DROP-then-CREATE (not CREATE OR REPLACE) because Postgres rejects
-- column-type changes in RETURNS TABLE via REPLACE — error 42P13:
-- "cannot change return type of existing function". We hit this when
-- the H4 audit fix changed pending_count/pending_retry_count from
-- bigint to integer. Wrapped in a transaction so the DROP→CREATE
-- window is atomic; concurrent callers block (don't error) on the
-- AccessExclusiveLock during DDL.
drop function if exists public.get_audience_suggestions(integer, integer);

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
  -- count(*)::int cast (audit 2026-05-22 H4): bigint serializes inconsistently
  -- across PostgREST configurations. Casting at the source forces integer over
  -- the wire so the TS handler can rely on row.pending_count being a number.
  -- Voizo prod will never hit int overflow on per-campaign phone counts.
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
  group by c.id, c.name, c.status
  having count(*) >= p_min_candidates
  order by max(n.last_attempted_at) desc nulls last
  limit p_max_results;
$$;

commit;

-- ── Smoke test (run after applying) ─────────────────────────────────────────
-- Default thresholds (5 candidates, 20 max):
--
-- select * from public.get_audience_suggestions();
--
-- Custom thresholds:
--
-- select * from public.get_audience_suggestions(p_min_candidates := 10, p_max_results := 5);
--
-- Expected behavior on staging right after applying 1g + 1h with the prod
-- data shape: zero suggestions (because every recyclable source on prod
-- right now already has a committed segment — the L7_AU 20/05 segment was
-- recreated after Phase 1B recovery). To get a non-empty result for
-- smoke-testing, either delete an existing segment first (which will
-- restore source rows to pending via the DELETE endpoint fix from 7bd654d)
-- or insert synthetic data.

-- ── Rollback (manual; uncomment and run if needed) ─────────────────────────
-- begin;
-- drop function if exists public.get_audience_suggestions(int, int);
-- commit;
