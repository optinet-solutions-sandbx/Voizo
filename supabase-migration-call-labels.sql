-- Reviewer Labeling — slice 1 of the Agent training/eval surface (2026-06-02)
--
-- A per-call human good/bad verdict + reason: the "gold label" that
--   (a) completes the Phase 0 premise check (label real calls in-app), and
--   (b) becomes the ground truth the QA Scorecard LLM-judge calibrates against.
--
-- SECURITY (deliberate — the OPPOSITE of the F1 "Allow all" finding):
--   RLS is enabled with NO anon/authenticated policy => default-deny for the
--   public anon key. All reads/writes go through server-side API routes using
--   the service role, which bypasses RLS. Do NOT add an "allow all" policy here.
--   This table is the template the F1 remediation should follow for the others.
--
-- Run in the Supabase SQL editor. Additive only — safe, no existing table touched.

create table if not exists call_labels (
  id uuid default gen_random_uuid() primary key,
  call_id uuid not null references calls_v2(id) on delete cascade,
  verdict text not null check (verdict in ('good', 'bad', 'unsure')),
  reason text,
  labeled_by text not null,            -- reviewer email/identifier (free-text until real auth)
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique (call_id, labeled_by)         -- one editable label per reviewer per call
);

create index if not exists idx_call_labels_call    on call_labels(call_id);
create index if not exists idx_call_labels_verdict on call_labels(verdict);

-- keep updated_at fresh (reuses set_updated_at() from supabase-migration-campaign-v2.sql)
create or replace trigger trg_call_labels_updated_at
  before update on call_labels
  for each row execute function set_updated_at();

-- ── RLS: default-deny for anon; the server's service role bypasses RLS ──
alter table call_labels enable row level security;
-- Intentionally NO policy => anon/authenticated cannot read or write via PostgREST.
-- (Contrast supabase-migration-campaign-v2.sql, which used "Allow all" — the F1 hole.)
