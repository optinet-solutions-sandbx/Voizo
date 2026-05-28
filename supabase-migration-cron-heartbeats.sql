-- Add cron_heartbeats table.
--
-- Used by /api/cron/alerts-hourly to detect silent cron failures. Each cron
-- route handler UPSERTs (name, last_success_at = now()) immediately before
-- its final JSON response, so a row's freshness implies the cron ran to
-- completion. alerts-hourly queries this table and posts to Slack when
-- last_success_at exceeds the per-cron staleness threshold (5min for the
-- 1-min scheduler, 90min for the 30-min heartbeat, etc.).
--
-- Phase 1 of docs/2026-05-28_DOC_Automation_Hardening_Roadmap.md
-- (Priority 3 - Operator alerting). Companion to the stuck-slot-watchdog
-- shipped 2026-05-28 (which addresses pool-side anomalies; this addresses
-- cron-pipeline-side anomalies).
--
-- Safe to apply: no backfill needed. IF NOT EXISTS so re-runs on a fresh
-- DB are idempotent.
--
-- Security: Supabase auto-generates a PostgREST endpoint for every public-
-- schema table. Without RLS, the anon key (which ships in the frontend JS
-- bundle by design) could SELECT / INSERT / UPSERT this table via the
-- public REST API. An attacker who extracted the anon key could UPSERT
-- `(campaign-scheduler, now())` on a tight loop to mask a real scheduler
-- failure and permanently blind the operator. We enable RLS with no
-- policies attached: service-role (supabaseAdmin used inside cron route
-- handlers) bypasses RLS; anon and authenticated roles get default-deny.

create table if not exists cron_heartbeats (
  name text primary key,
  last_success_at timestamptz not null default now()
);

alter table cron_heartbeats enable row level security;
