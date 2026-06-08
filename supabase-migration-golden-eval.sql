-- Golden Eval Set — Phase A capstone of the Agent eval/improvement loop (2026-06-08)
--
-- A FROZEN, VERSIONED, CLEAN ruler. Calibration today joins the judge against the
-- LIVE, mutable, ~78%-voicemail-contaminated call_labels (via the qa_calibration
-- view), so every kappa is non-comparable over time. These tables freeze a clean
-- snapshot of (transcript + trusted human good/bad label) so the judge can be
-- re-run against the SAME fixed set and the delta is real (MLOps §4.2/§4.4).
--   * golden_eval_sets  — the version registry (one row per frozen cut).
--   * golden_eval_items — the frozen ruler (immutable transcript COPIES; good/bad only —
--                         'unsure' is not measurable agreement, excluded at freeze).
--   * golden_eval_runs  — the drift log (one row per replay, kept over time).
--
-- SECURITY (anti-F1; follows supabase-migration-call-labels.sql / -qa-scores.sql /
-- -prompt-versions.sql, NOT the legacy "allow all" in -campaign-v2.sql):
--   RLS enabled, NO anon/authenticated policy => default-deny for the public anon
--   key. All reads/writes go through server-side routes using the service role,
--   which bypasses RLS. Do NOT add an "allow all" policy here.
--
-- Append-only / immutable by design: no updated_at, no set_updated_at() trigger
-- (mirrors prompt_versions). A new cut is a new version row; a re-replay is a new
-- run row — existing rows are never mutated.
--
-- Run in the Supabase SQL editor. Additive only — safe, no existing table touched.

-- ── The version registry: one row per frozen cut ──
create table if not exists golden_eval_sets (
  id uuid default gen_random_uuid() primary key,
  version integer not null,                -- monotonic v1, v2, … (assigned max+1 at freeze)
  note text,                               -- human description of this cut
  source_filter jsonb not null default '{}'::jsonb,  -- provenance: campaigns/date-range/filters + skip counts
  item_count integer not null default 0,
  created_at timestamptz default now() not null,
  unique (version)                         -- prevents two cuts sharing a version (concurrency guard)
);

-- ── The frozen ruler: immutable copies. A call appears at most once per set ──
create table if not exists golden_eval_items (
  id uuid default gen_random_uuid() primary key,
  set_id uuid not null references golden_eval_sets(id) on delete cascade,
  call_id uuid references calls_v2(id) on delete set null,  -- soft provenance; survives a call purge
  source text not null default 'real' check (source in ('real','synthetic')),
  transcript jsonb not null,               -- FROZEN COPY of calls_v2.transcript at freeze time
  human_verdict text not null check (human_verdict in ('good','bad')),  -- ruler is good/bad only
  human_reason text,                       -- frozen reason
  labeled_by text,                         -- provenance of the label
  duration_seconds integer,                -- frozen, for the scorer's guards
  goal_reached_at_freeze boolean,          -- audit: the old regex ruler's answer at freeze
  created_at timestamptz default now() not null,
  unique (set_id, call_id)                 -- NULL call_id (synthetic) treated distinct by PG
);

create index if not exists idx_golden_items_set on golden_eval_items(set_id);

-- ── The drift log: one row per replay, kept over time (NO unique on judge_version) ──
create table if not exists golden_eval_runs (
  id uuid default gen_random_uuid() primary key,
  set_id uuid not null references golden_eval_sets(id) on delete cascade,
  judge_version text not null,             -- sha256(system prompt + model id); the drift key
  judge_model text not null,
  n integer not null default 0,            -- DECIDED items scored (good/bad, judge non-unsure)
  agreement numeric,
  cohens_kappa numeric,
  tp integer,
  tn integer,
  fp integer,
  fn integer,
  run_meta jsonb not null default '{}'::jsonb,  -- skip counts (voicemail/too-short/api-error/unparsable), totals
  created_at timestamptz default now() not null
);

create index if not exists idx_golden_runs_set_judge_time
  on golden_eval_runs(set_id, judge_version, created_at desc);

-- ── RLS: default-deny for anon; the server's service role bypasses RLS ──
alter table golden_eval_sets  enable row level security;
alter table golden_eval_items enable row level security;
alter table golden_eval_runs  enable row level security;
-- Intentionally NO policy on any of the three => anon/authenticated cannot read or
-- write via PostgREST. (Contrast supabase-migration-campaign-v2.sql "Allow all" — the F1 hole.)
