-- Scheduler "outside call window" alert dedup state (2026-06-04).
--
-- The campaign-scheduler cron (runs every ~60s) skips a due draft campaign that
-- is outside its call window and defers to the next tick. For a campaign that is
-- structurally stuck (e.g. day-of-week / window mismatch, or a classic-created
-- campaign that bypassed the creation guards) this is a SILENT never-dials.
-- Surfacing it to #voizo-alerts without dedup would post ~1,440 messages/day per
-- stuck campaign. This table caps it at one alert per campaign per dedup window
-- (6h in code, see src/lib/alerts/slack.ts shouldAlertSpawnFail). The row is
-- cleared when the campaign successfully transitions draft -> running, so a
-- future re-defer (e.g. after an edit) can alert again. Mirrors
-- recurring_alert_state (the recurring spawn_failed dedup precedent).
--
-- Apply to voizo-sandbox FIRST, confirm, then prod (per the standing flow).
--
-- Service-role only: RLS ENABLED with NO policies -> anon + authenticated are
-- default-denied; the service role (cron via supabaseAdmin) bypasses RLS. Per
-- the standing rule, every new public-schema table gets RLS even when no human
-- query path exists (the anon key ships in the frontend bundle + PostgREST
-- auto-exposes the table).

create table if not exists public.scheduler_alert_state (
  campaign_id uuid primary key references public.campaigns_v2(id) on delete cascade,
  reason text not null,
  last_alerted_at timestamptz not null default now()
);

alter table public.scheduler_alert_state enable row level security;
