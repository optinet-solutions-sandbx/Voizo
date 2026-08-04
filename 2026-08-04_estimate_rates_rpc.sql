-- 2026-08-04_estimate_rates_rpc.sql
-- Campaign cost estimator — empirical behavior rates (spec 2026-08-04 §5).
-- READ-ONLY aggregate over calls_v2/campaigns_v2/campaign_numbers_v2.
-- Aggregation MUST live in SQL: a supabase-js select+reduce silently clamps
-- at 1000 rows (PostgREST max-rows, measured 2026-07-30).
-- ONE CLOCK: talk = duration_seconds (FS billsec). Window floored at the
-- billsec epoch 2026-07-28 (VOZ-247, 2e2145b) — earlier rows include ring time.
-- Healthy-day filter: drop UTC days with <50 dials or >30% CALL_REJECTED
-- (keeps 08-02/03-style incidents out of the averages); dropped days are
-- returned in excludedDays for the audit panel.
-- Naming: estimate_rates_v1 — deliberately distinct from the (uncommitted)
-- dashboard-sql-rollup RPCs in worktree-dashboard-sql-rollup.

create or replace function estimate_rates_v1(
  p_parent_id uuid default null,
  p_timezones text[] default null
) returns jsonb
language sql
stable
as $$
with base as (
  select cv.created_at, cv.hangup_cause, cv.duration_seconds, cv.voicemail,
         cv.campaign_number_id, cv.campaign_id,
         (cv.created_at at time zone 'UTC')::date as d,
         date_trunc('hour', cv.created_at) as hr
  from calls_v2 cv
  join campaigns_v2 c on c.id = cv.campaign_id
  where c.is_test = false
    and cv.created_at >= greatest(now() - interval '30 days', timestamp '2026-07-28')
    and (p_parent_id is null or c.parent_campaign_id = p_parent_id or c.id = p_parent_id)
    and (p_timezones is null or c.timezone = any(p_timezones))
),
day_stats as (
  select d,
         count(*) as dials,
         count(*) filter (where hangup_cause = 'CALL_REJECTED')::numeric
           / greatest(count(*), 1) as reject_share
  from base
  group by d
),
healthy_days as (
  select d from day_stats where dials >= 50 and reject_share <= 0.30
),
excluded_days as (
  select d from day_stats where d not in (select d from healthy_days)
),
h as (
  select b.* from base b join healthy_days hd on hd.d = b.d
),
connected as (
  select * from h where hangup_cause = 'NORMAL_CLEARING' and duration_seconds > 0
),
throughput as (
  -- dials per campaign-hour proxy: dials on a campaign-day ÷ distinct active hours
  select count(*)::numeric / greatest(count(distinct hr), 1) as dph
  from h
  group by campaign_id, d
),
terminal_players as (
  select count(distinct n.id) as cnt
  from campaign_numbers_v2 n
  where n.id in (select distinct campaign_number_id from h where campaign_number_id is not null)
    and n.outcome not in ('pending', 'pending_retry', 'in_progress')
)
select jsonb_build_object(
  'sampleDials',       (select count(*) from h),
  'samplePlayers',     (select count(distinct campaign_number_id) from h),
  'p',                 case when (select count(*) from h) = 0 then null
                            else round((select cnt from terminal_players)::numeric
                                       / (select count(*) from h), 6) end,
  'rConnect',          case when (select count(*) from h) = 0 then null
                            else round((select count(*) from connected)::numeric
                                       / (select count(*) from h), 6) end,
  'tTalkSec',          (select round(avg(duration_seconds)::numeric, 2) from connected),
  'tTalkHumanSec',     (select round(avg(duration_seconds)::numeric, 2) from connected where voicemail is not true),
  'tTalkVoicemailSec', (select round(avg(duration_seconds)::numeric, 2) from connected where voicemail is true),
  'voicemailShare',    case when (select count(*) from connected) = 0 then null
                            else (select round((count(*) filter (where voicemail is true))::numeric
                                               / count(*), 6) from connected) end,
  'dialsPerHourP25',   (select round((percentile_cont(0.25) within group (order by dph))::numeric, 2) from throughput),
  'dialsPerHourP50',   (select round((percentile_cont(0.50) within group (order by dph))::numeric, 2) from throughput),
  'dialsPerHourP75',   (select round((percentile_cont(0.75) within group (order by dph))::numeric, 2) from throughput),
  'windowFrom',        (select min(created_at) from h),
  'windowTo',          (select max(created_at) from h),
  'excludedDays',      coalesce((select jsonb_agg(d order by d) from excluded_days), '[]'::jsonb),
  'computedAt',        now()
);
$$;
