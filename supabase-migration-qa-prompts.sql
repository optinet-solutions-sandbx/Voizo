-- QA Prompt Testing — the prompt library (2026-08-04)
--
-- Backs the "QA Prompt Testing" tool (Reviews area): a reusable library of QA
-- classification prompts operators test against real call transcripts. One row
-- per prompt version; `is_active` marks the default the tester pre-loads.
--
-- SECURITY (mirrors supabase-migration-call-labels.sql — the default-deny template):
--   RLS is enabled with NO anon/authenticated policy => default-deny for the
--   public anon key. All reads/writes go through server-side /api/qa-prompt-testing/*
--   routes using the service role, which bypasses RLS. Do NOT add an "allow all".
--
-- Run in the Supabase SQL editor. Additive only — safe, no existing table touched.
-- After applying, seed the library with: node scripts/seed-qa-prompts.mjs

create table if not exists listener_qa_prompts (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  content text not null,
  is_active boolean default false not null,   -- the default prompt pre-loaded in the tester
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index if not exists idx_listener_qa_prompts_active on listener_qa_prompts(is_active);

-- keep updated_at fresh (reuses set_updated_at() from supabase-migration-campaign-v2.sql)
create or replace trigger trg_listener_qa_prompts_updated_at
  before update on listener_qa_prompts
  for each row execute function set_updated_at();

-- ── RLS: default-deny for anon; the server's service role bypasses RLS ──
alter table listener_qa_prompts enable row level security;
-- Intentionally NO policy => anon/authenticated cannot read or write via PostgREST.
