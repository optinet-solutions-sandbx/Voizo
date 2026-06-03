-- Prompt Versioning — slice 2 of the Agent training/eval surface (2026-06-03)
--
-- The KEYSTONE of the eval loop: an append-only, immutable snapshot of the
-- EXACT effective system prompt (+ best-effort model/voice metadata) that a
-- campaign's cloned Vapi assistant actually ran with. Today campaigns_v2 keeps
-- only the CURRENT raw agent prompt (system_prompt) and the clone id
-- (vapi_assistant_id) — no history, no hash, no Voizo-prefix-included effective
-- text. Without this table you cannot answer "did prompt v7 beat v6?".
--
-- This is OBSERVABILITY OF WHAT RAN (provenance of a real production call),
-- not prompt iteration — the same carve-out that justified slice-1 call_labels.
-- It is written ONLY by server-side code (service role) AFTER a clone is created,
-- by re-reading the immutable clone from Vapi. It is never an authoring surface.
--
-- SECURITY (deliberate — the OPPOSITE of the F1 "Allow all" finding):
--   RLS is enabled with NO anon/authenticated policy => default-deny for the
--   public anon key. All reads/writes go through server-side API routes / libs
--   using the service role, which bypasses RLS. Do NOT add an "allow all" policy
--   here. Follows supabase-migration-call-labels.sql (the anti-F1 template);
--   NOT the legacy "for all using(true)" pattern in supabase-migration-campaign-v2.sql.
--
-- Run in the Supabase SQL editor. Additive only — safe, no existing table touched.

create table if not exists prompt_versions (
  id uuid default gen_random_uuid() primary key,
  campaign_id uuid not null references campaigns_v2(id) on delete cascade,

  -- The cloned Vapi assistant this prompt ran on (mirrors campaigns_v2.vapi_assistant_id).
  assistant_id text not null,

  -- The exact, fully-resolved system prompt that was live for this version:
  -- VOIZO_SYSTEM_PREFIX + agent prompt, as actually POSTed to Vapi.
  system_prompt text not null,

  -- sha256 of system_prompt (lowercase hex). Dedupes identical prompts and lets
  -- the eval loop detect drift ("v6 -> v7") without diffing large text blobs.
  prompt_sha256 text not null,

  -- Best-effort generation/model metadata captured from the clone's Vapi config,
  -- e.g. { "provider":"openai", "model":"gpt-4o", "maxTokens":150, "temperature":0.7 }.
  -- jsonb (not columns) because capture is best-effort and Vapi may add/rename fields.
  model_meta jsonb not null default '{}'::jsonb,

  -- Best-effort voice metadata, e.g. { "provider":"11labs", "voiceId":"...", "stability":0.85 }.
  voice_meta jsonb not null default '{}'::jsonb,

  -- Append-only snapshot: versions are immutable, so there is NO updated_at and
  -- NO update trigger (contrast call_labels, which is editable per reviewer).
  created_at timestamptz default now() not null
);

-- Campaign-scoped reads + "latest version for a campaign" ordering (the eval
-- loop's real read pattern). Its leftmost prefix (campaign_id) also serves plain
-- campaign_id lookups, so no separate single-column index is needed. Deliberately
-- NO standalone assistant_id / prompt_sha256 indexes yet — this table is written
-- on every launch/rebind/spawn, and there is no reader for those columns until
-- the eval-loop UI lands. Add them with their query, not before.
create index if not exists idx_prompt_versions_campaign_created
  on prompt_versions(campaign_id, created_at desc);

-- Idempotent snapshotting: never store the same effective prompt twice for one
-- campaign. Backs the server-side upsert(onConflict: "campaign_id,prompt_sha256",
-- ignoreDuplicates: true) so a rebind/resume that changed nothing is a no-op,
-- while a real prompt change inserts a new (higher-sha) version row.
create unique index if not exists uq_prompt_versions_campaign_sha
  on prompt_versions(campaign_id, prompt_sha256);

-- ── RLS: default-deny for anon; the server's service role bypasses RLS ──
alter table prompt_versions enable row level security;
-- Intentionally NO policy => anon/authenticated cannot read or write via PostgREST.
-- (Follows supabase-migration-call-labels.sql; NOT the "Allow all" F1 pattern.)
