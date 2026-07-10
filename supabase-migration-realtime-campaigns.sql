-- Real-time campaigns (VOZ-132). Apply BEFORE deploying the realtime build.
-- Pattern: additive + default-deny RLS (matches qa_scores / cron_heartbeats).
-- Apply to voizo-sandbox (staging) FIRST, confirm, then prod.

-- 1) Campaign flags. `realtime` marks BOTH the parent (poll target) and its
--    spawned children (the scheduler's keep-awake guard reads it off the
--    child row). `daily_cap` = max players ADDED to a child per day (the
--    cost brake for real-time campaigns — spec §7).
alter table public.campaigns_v2
  add column if not exists realtime boolean not null default false;
alter table public.campaigns_v2
  add column if not exists daily_cap integer
  check (daily_cap is null or daily_cap > 0);

-- 2) Already-called memory + race-proof no-duplicates rule (spec items 1+3).
--    One row per (parent, Customer.io member) EVER seen. The PK is the door:
--    two overlapping poll ticks both try to claim a member; exactly one
--    INSERT wins, and only the winner inserts the dial row. `status` records
--    why non-queued members were set aside. `child_campaign_id` = which
--    day-child received the dial row.
create table if not exists public.realtime_seen_members (
  parent_campaign_id uuid not null references public.campaigns_v2(id) on delete cascade,
  cio_id text not null,
  phone_e164 text,
  status text not null check (status in
    ('queued','rejected_country','no_phone','invalid_phone','lookup_failed')),
  child_campaign_id uuid references public.campaigns_v2(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  primary key (parent_campaign_id, cio_id)
);
alter table public.realtime_seen_members enable row level security;
-- default-deny: no policies. Server-side access uses the service role.

-- 3) Alert dedup for per-tick conditions that would otherwise post to Slack
--    every minute (daily-cap hit, fallen-behind). Kind-scoped so the two
--    alerts don't suppress each other (scheduler_alert_state is
--    campaign-keyed only, hence a separate table).
create table if not exists public.realtime_alert_state (
  child_campaign_id uuid not null references public.campaigns_v2(id) on delete cascade,
  kind text not null,
  last_alerted_at timestamptz not null,
  primary key (child_campaign_id, kind)
);
alter table public.realtime_alert_state enable row level security;
