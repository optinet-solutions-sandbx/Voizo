-- GhostPortal Phase 1 — internal parallel-dialer ingress + audit.
-- Additive only. RLS = call_labels template (enable, NO policy, service-role only).
-- Apply to the voizo-sandbox prod DB. Safe: new table + one additive column with a
-- back-compatible default; no existing table data is modified.

create table if not exists ghost_runs (
  id                uuid default gen_random_uuid() primary key,
  slug              text unique not null,
  name              text not null,
  operator          text not null,                       -- auth identity (DASHBOARD_USERNAME for now)
  tier              text not null check (tier in ('test','live')),
  base_assistant_id text not null,
  status            text not null default 'draft'
                    check (status in ('draft','scrubbing','ready','launching','launched','failed')),
  uploaded_count    int not null default 0,
  scrubbed_count    int not null default 0,
  suppressed_count  int not null default 0,
  fail_reason       text,
  campaign_id       uuid references campaigns_v2(id) on delete set null,
  created_at        timestamptz default now() not null,
  updated_at        timestamptz default now() not null,
  launched_at       timestamptz
);

create index if not exists idx_ghost_runs_status   on ghost_runs(status);
create index if not exists idx_ghost_runs_campaign on ghost_runs(campaign_id);

-- reuse set_updated_at() from supabase-migration-campaign-v2.sql
create or replace trigger trg_ghost_runs_updated_at
  before update on ghost_runs
  for each row execute function set_updated_at();

-- ── RLS: default-deny (anon/authenticated); service role bypasses. NO policy. ──
alter table ghost_runs enable row level security;

-- ── Discriminator on the production campaign table (back-compatible default) ──
alter table campaigns_v2 add column if not exists source text not null default 'production';
create index if not exists idx_campaigns_v2_source on campaigns_v2(source);

-- Verify after apply:
--   select source, count(*) from campaigns_v2 group by source;   -- expect all 'production'
--   select count(*) from ghost_runs;                              -- expect 0
--   (anon-key probe like scripts/_probe-rls.cjs) -> ghost_runs read DENIED
