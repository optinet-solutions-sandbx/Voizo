-- Campaign agent mode (VOZ-155) — lets a campaign run a Script instead of a
-- raw VAPI assistant. Additive; plan §2.1. Nothing changes for existing
-- campaigns: agent_mode defaults to 'assistant' (today's behavior).
--
-- Pattern: additive + `add column if not exists` (idempotent). Apply to
-- voizo-sandbox (STAGING) first, confirm, then prod. No RLS change — reuses
-- the existing campaigns_v2 policy.

-- `agent_mode`: 'assistant' = pick a VAPI assistant + prompt (default, current
-- flow, untouched). 'script' = pick a Script; the clone is composed from the
-- graph at launch (see composeAssistant, VOZ-156). The inline CHECK rides the
-- add-column, so re-running is a no-op once the column exists.
alter table public.campaigns_v2
  add column if not exists agent_mode text not null default 'assistant'
    check (agent_mode in ('assistant','script'));

-- Which Script this campaign runs (null for assistant-mode). Not a FK: scripts
-- live in listener_scripts and may be edited/removed independently; the launch
-- path resolves + validates the id (a missing script fails preflight, VOZ-159).
alter table public.campaigns_v2
  add column if not exists script_id uuid;

-- Denormalized script name for display/audit without a join (mirrors
-- vapi_assistant_name). Kept in sync at launch.
alter table public.campaigns_v2
  add column if not exists script_name text;

-- Partial index: only script-mode campaigns carry a script_id.
create index if not exists idx_campaigns_v2_script
  on public.campaigns_v2(script_id) where script_id is not null;
