-- QA Prompt Testing — daily auto-analysis schedule (2026-08-06)
--
-- Single-row config for the scheduled daily bulk analysis (the /api/cron/qa-analysis-daily
-- cron reads it): whether it's on, and which prompt to run against yesterday's reached calls
-- across all campaigns. OFF by default — enabling it starts standing daily OpenAI spend.
--
-- SECURITY: default-deny RLS (mirrors the other listener_qa_* tables); all access via
-- server-side /api/qa-prompt-testing/* + the cron, using the service role.
--
-- Run in the Supabase SQL editor. Additive only — safe.

create table if not exists listener_qa_schedule (
  id text primary key default 'default',            -- singleton row
  enabled boolean not null default false,
  prompt_id uuid,                                    -- which library prompt the daily run uses
  last_run_at timestamptz,                           -- when the cron last submitted
  last_run_summary text,                             -- human note: "submitted N batches / M calls"
  updated_at timestamptz not null default now()
);

-- keep updated_at fresh (reuses set_updated_at() from supabase-migration-campaign-v2.sql)
create or replace trigger trg_listener_qa_schedule_updated_at
  before update on listener_qa_schedule
  for each row execute function set_updated_at();

alter table listener_qa_schedule enable row level security;
-- Intentionally NO policy => anon/authenticated cannot read or write via PostgREST.

-- seed the singleton row (disabled)
insert into listener_qa_schedule (id, enabled) values ('default', false)
  on conflict (id) do nothing;
