-- QA Scorecard — slice 3 of the Agent training/eval surface (2026-06-05)
--
-- The success-first LLM judge's output store + its calibration view. The judge
-- (Anthropic Claude, a DIFFERENT family than the OpenAI call model) is a
-- CALIBRATED alternative to the regex goal_reached ruler; quality axes are
-- secondary/diagnostic; compliance axis deliberately ABSENT (PII/legal).
--
-- SECURITY (anti-F1; follows supabase-migration-call-labels.sql /
-- -prompt-versions.sql, NOT the legacy "allow all" in -campaign-v2.sql):
--   * Table RLS enabled, NO anon/authenticated policy => default-deny.
--   * The VIEW is created WITH (security_invoker = true) so it runs with the
--     QUERYING role's RLS — anon hits the underlying default-deny and gets
--     nothing. Plus an explicit REVOKE as belt-and-suspenders. Service role
--     (server routes) bypasses RLS and reads both.
--   Do NOT add an "allow all" policy. Do NOT drop security_invoker.
--
-- Run in the Supabase SQL editor. Additive only — no existing table touched.

create table if not exists qa_scores (
  id uuid default gen_random_uuid() primary key,
  call_id uuid not null references calls_v2(id) on delete cascade,
  campaign_id uuid references campaigns_v2(id) on delete set null,

  -- Best-effort prompt-version attribution (SPEC §3 "Attributed (honestly)").
  prompt_version_id uuid references prompt_versions(id) on delete set null,
  prompt_version_match text not null default 'unresolved'
    check (prompt_version_match in ('single','time_window','ambiguous','unresolved')),

  -- PRIMARY: the success signal (replaces the regex ruler). NULL for non-conversations.
  success_verdict text check (success_verdict in ('success','failure','unsure')),
  success_confidence numeric check (success_confidence >= 0 and success_confidence <= 1),
  success_path text check (success_path in ('sms','email','login_activate','deposit','none')),

  -- Audit copy of the OLD ruler's answer at score time (drift tracking; never overwrites it).
  goal_reached_at_score boolean,

  -- SECONDARY diagnostic axes (1-5, nullable). Compliance axis deliberately absent.
  axis_accuracy smallint check (axis_accuracy between 1 and 5),
  axis_clarity smallint check (axis_clarity between 1 and 5),
  axis_natural_flow smallint check (axis_natural_flow between 1 and 5),

  rationale text,                          -- one-liner citing the decisive moment
  judge_model text not null,               -- e.g. 'claude-sonnet-4-6'
  judge_version text not null,             -- sha256(system prompt + model id); drift key
  judge_meta jsonb not null default '{}'::jsonb,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,

  -- Overwrite-in-place per (call, judge_version); append a new row across versions
  -- (so "did the judge improve after we tuned it?" stays answerable).
  unique (call_id, judge_version)
);

create index if not exists idx_qa_scores_call          on qa_scores(call_id);
create index if not exists idx_qa_scores_campaign       on qa_scores(campaign_id);
create index if not exists idx_qa_scores_judge_version  on qa_scores(judge_version);

-- keep updated_at fresh (reuses set_updated_at() from supabase-migration-campaign-v2.sql)
create or replace trigger trg_qa_scores_updated_at
  before update on qa_scores
  for each row execute function set_updated_at();

alter table qa_scores enable row level security;
-- Intentionally NO policy => anon/authenticated cannot read or write via PostgREST.

-- ── Calibration view: judge verdict ⨝ human label, per call ──
-- Binary success axis: human good->success, bad->failure, unsure->NULL (excluded).
-- security_invoker => respects the caller's RLS (anon denied; service role reads).
create or replace view qa_calibration
  with (security_invoker = true)
as
select
  s.call_id,
  s.campaign_id,
  s.judge_version,
  s.judge_model,
  s.success_verdict,
  s.success_confidence,
  s.goal_reached_at_score,
  l.verdict        as human_verdict,
  l.labeled_by,
  case when l.verdict = 'good' then 'success'
       when l.verdict = 'bad'  then 'failure'
       else null end as human_success,
  s.created_at     as scored_at
from qa_scores s
join call_labels l on l.call_id = s.call_id;

revoke all on qa_calibration from anon, authenticated;
