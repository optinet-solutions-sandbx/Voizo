-- Dashboard Rebuild Phase 1f — Audience CRM / Lead Recycling
-- Plan:   .claude/plans/new-shift-picking-gentle-puffin.md Slice 1
-- Date:   2026-05-21
--
-- Adds two new tables that back the /audience tab. Operators carve outcome-
-- tagged phones out of finished campaigns into reusable local segments, with
-- DNC + N-day recency scrubbing applied at create-time.
--
-- Tables:
--   local_segments         — segment metadata + snapshot counts
--   local_segment_numbers  — per-segment phone list with source outcome
--
-- Both tables are write-from-app-only — no dialer code path reads or writes
-- them. The hand-off to the dialer goes through the existing wizard's
-- numbersText / manualPasteMode contract (no FK from campaigns_v2 to
-- local_segments). This keeps the call-path code untouched per CLAUDE.md
-- non-negotiable #4 (cost-aware) — recycled-segment campaigns dial identically
-- to manually pasted ones.
--
-- RLS: permissive ("allow all") to match the PoC pattern on campaigns_v2 et al
-- (see supabase-migration-campaign-v2.sql:175-186).
--
-- Non-destructive: pure ADD. No existing-row migration. Safe to re-run via
-- "if not exists" / "if not exists" everywhere.
--
-- Run against STAGING (voizo-sandbox) first. Prod (voizo-eight) waits on
-- Chris's sign-off per the no-prod-commit-without-Chris rule.

begin;

create extension if not exists pgcrypto;

-- ── local_segments ─────────────────────────────────────────────────────────
create table if not exists public.local_segments (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (char_length(name) between 1 and 120),
  -- Provenance — snapshot at create-time (campaign may be renamed/deleted later)
  source_campaign_id    uuid references public.campaigns_v2(id) on delete set null,
  source_campaign_name  text,
  -- Filters applied at create-time (informational only; not re-evaluated)
  outcomes_included     text[] not null,
  dnc_scrubbed          boolean not null default true,
  recent_window_days    integer not null default 7 check (recent_window_days >= 0),
  -- Snapshot counts (set once at create-time; never auto-updated)
  total_count           integer not null default 0,
  scrubbed_count        integer not null default 0,
  created_at            timestamptz not null default now(),
  created_by            text
);

create index if not exists idx_local_segments_created_at
  on public.local_segments (created_at desc);

-- ── local_segment_numbers ──────────────────────────────────────────────────
create table if not exists public.local_segment_numbers (
  id              uuid primary key default gen_random_uuid(),
  segment_id      uuid not null references public.local_segments(id) on delete cascade,
  phone_e164      text not null,
  source_outcome  text not null,
  source_attempts integer,
  created_at      timestamptz not null default now(),
  -- Same phone can appear in many segments, but not twice within one segment
  unique (segment_id, phone_e164)
);

create index if not exists idx_local_segment_numbers_segment
  on public.local_segment_numbers (segment_id);

-- ── RLS (permissive PoC pattern; tighten when auth model lands post-demo) ──
alter table public.local_segments        enable row level security;
alter table public.local_segment_numbers enable row level security;

create policy "Allow all on local_segments"
  on public.local_segments
  for all using (true) with check (true);

create policy "Allow all on local_segment_numbers"
  on public.local_segment_numbers
  for all using (true) with check (true);

commit;

-- ── Rollback (manual; uncomment and run in a single transaction) ───────────
-- DROPs cascade local_segment_numbers via the FK with on delete cascade. Safe
-- as long as no production data references these tables.
--
-- begin;
-- drop policy if exists "Allow all on local_segment_numbers" on public.local_segment_numbers;
-- drop policy if exists "Allow all on local_segments"        on public.local_segments;
-- drop table if exists public.local_segment_numbers;
-- drop table if exists public.local_segments;
-- commit;
