-- GhostPortal v1.1 — per-run MANUAL call labels, isolated from the main call_labels.
-- Additive only. RLS = enable, NO policy (service-role only; default-deny anon).
-- Apply to the voizo-sandbox prod DB. Safe: one new table; no existing data modified.
-- The main AI ("Claude") QA judge does NOT write here — this is the Chris+Jas
-- manual review store, reviewed only on /s/<slug>.

create table if not exists ghost_call_labels (
  call_id    uuid not null references calls_v2(id) on delete cascade,
  labeled_by text not null,                 -- operator identity (DASHBOARD_USERNAME for now)
  verdict    text not null check (verdict in ('good','bad','unsure')),
  reason     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (call_id, labeled_by)         -- one verdict per reviewer per call (upsert)
);

create index if not exists idx_ghost_call_labels_call on ghost_call_labels(call_id);

-- reuse set_updated_at() from supabase-migration-campaign-v2.sql
create or replace trigger trg_ghost_call_labels_updated_at
  before update on ghost_call_labels
  for each row execute function set_updated_at();

-- ── RLS: default-deny (anon/authenticated); service role bypasses. NO policy. ──
alter table ghost_call_labels enable row level security;

-- Verify after apply:
--   select count(*) from ghost_call_labels;                 -- expect 0
--   (anon-key probe) -> ghost_call_labels read DENIED
