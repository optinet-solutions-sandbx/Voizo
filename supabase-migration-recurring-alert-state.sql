-- Recurring spawn-failure alert dedup state (audit 2026-05-29 A2).
--
-- A misconfigured recurring parent (e.g. deleted base_assistant_id, desynced
-- call_hours) returns spawn_failed on EVERY ~60s campaign-scheduler tick.
-- Without dedup that would post ~1,440 Slack messages/day. This table lets the
-- scheduler alert at most once per parent per dedup window (6h in code, see
-- src/lib/alerts/slack.ts shouldAlertSpawnFail) instead of spamming #voizo-alerts.
--
-- Apply to voizo-sandbox (staging) FIRST, confirm, then voizo-eight (prod).
--
-- Service-role only: written/read exclusively by the campaign-scheduler cron via
-- supabaseAdmin. RLS is ENABLED with NO policies -> anon + authenticated are
-- default-denied; the service role bypasses RLS. Per the standing rule, every
-- new public-schema table gets RLS even when no human query path exists (the
-- anon key ships in the frontend bundle + PostgREST auto-exposes the table).

create table if not exists public.recurring_alert_state (
  parent_id uuid primary key references public.campaigns_v2(id) on delete cascade,
  reason text not null,
  last_alerted_at timestamptz not null default now()
);

alter table public.recurring_alert_state enable row level security;
