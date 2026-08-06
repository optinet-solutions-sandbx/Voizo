-- QA Prompt Testing — bulk (batch) analysis + analysis history (2026-08-05)
--
-- Two tables backing per-campaign bulk analysis via the OpenAI Batch API:
--   • listener_qa_batch_jobs   — one row per submitted OpenAI batch (submit / poll /
--                                import / cancel lifecycle), scoped to a campaign.
--   • listener_qa_analysis_runs — one row per (call, batch job): the stored prompt +
--                                model output. This is what /qa-prompt-testing Analysis
--                                History lists and the run-detail view replays.
--
-- SECURITY (mirrors supabase-migration-call-labels.sql / -qa-prompts.sql): RLS on,
-- NO anon policy => default-deny. All access via /api/qa-prompt-testing/* (service role).
--
-- Run in the Supabase SQL editor. Additive only — safe, no existing table touched.

create table if not exists listener_qa_batch_jobs (
  id uuid default gen_random_uuid() primary key,
  campaign_id uuid not null references campaigns_v2(id) on delete cascade,
  openai_batch_id text,
  openai_file_id text,
  output_file_id text,
  status text not null default 'pending',       -- pending|validating|in_progress|finalizing|completed|expired|cancelling|cancelled|failed
  prompt_id uuid,
  prompt_title text,
  prompt_content text not null,
  chunk_index int not null default 0,
  total_chunks int not null default 1,
  total_conversations int not null default 0,   -- reached calls submitted in this job
  completed_conversations int not null default 0,
  failed_conversations int not null default 0,
  imported_count int not null default 0,        -- resume cursor for import
  error_message text,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_qa_batch_jobs_campaign on listener_qa_batch_jobs(campaign_id);
create index if not exists idx_qa_batch_jobs_status   on listener_qa_batch_jobs(status);

create table if not exists listener_qa_analysis_runs (
  id uuid default gen_random_uuid() primary key,
  call_id uuid not null references calls_v2(id) on delete cascade,
  campaign_id uuid not null references campaigns_v2(id) on delete cascade,  -- FK so PostgREST can embed campaigns_v2
  prompt_id uuid,
  prompt_title text,
  prompt_content text not null,
  summary text,                                 -- raw model output (JSON or prose)
  batch_job_id uuid references listener_qa_batch_jobs(id) on delete set null,
  analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- one stored run per (call, batch job) => re-importing a job is idempotent (upsert).
  unique (call_id, batch_job_id)
);
create index if not exists idx_qa_runs_campaign   on listener_qa_analysis_runs(campaign_id);
create index if not exists idx_qa_runs_call        on listener_qa_analysis_runs(call_id);
create index if not exists idx_qa_runs_prompt      on listener_qa_analysis_runs(campaign_id, prompt_id);
create index if not exists idx_qa_runs_analyzed_at on listener_qa_analysis_runs(analyzed_at desc);

-- keep updated_at fresh on batch jobs (reuses set_updated_at() from campaign-v2 migration)
create or replace trigger trg_qa_batch_jobs_updated_at
  before update on listener_qa_batch_jobs
  for each row execute function set_updated_at();

-- ── RLS: default-deny for anon; the server's service role bypasses RLS ──
alter table listener_qa_batch_jobs enable row level security;
alter table listener_qa_analysis_runs enable row level security;
-- Intentionally NO policy => anon/authenticated cannot read or write via PostgREST.
