-- Script Engine (VOZ-147) — the 8 tables the ported Listener/Script runtime needs.
-- Source: docs/VOIZO-SCRIPT-ENGINE-MIGRATION-PLAN.md §1.2 (repo optinet-solutions-automation/vapi-voiceagent-test).
--
-- Pattern: additive + PERMISSIVE RLS (matches the campaigns_v2 precedent, NOT
--   the default-deny call_labels one). The Playbook + Script Builder UIs read and
--   write these tables directly from the browser via the anon client (the engine
--   is isomorphic by design — see src/lib/scriptEngine/client.ts), so an
--   "allow all" policy is required. Fold into Voizo's RLS Phase A later.
--
-- Apply to voizo-sandbox (STAGING) FIRST, confirm, then prod. Idempotent:
--   create ... if not exists + drop-then-create policies, safe to re-run.
--
-- Load-bearing DDL quirks (do NOT "fix"):
--   * listener_script_nodes.id / listener_script_edges.id are client-generated
--     uuids — NO default. The Script Builder mints ids browser-side.
--   * lab_call_events.id is a bigint identity — the row id IS the per-call
--     ordering anchor (never timestamps; server/DB clock skew broke a watchdog).
--   * lab_call_flow_state.updated_at is the optimistic-lock token.

-- ── Playbook: scenarios (handlers) ─────────────────────────────────────────
create table if not exists public.listener_handlers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  intent_key text not null unique,
  description text not null default '',
  response_template text not null default '',
  action_type text not null default 'answer'
    check (action_type in ('answer','send_sms','give_offer','end_call','ignore')),
  delivery text not null default 'reword' check (delivery in ('verbatim','reword')),
  group_name text not null default '',
  tags text[] not null default '{}',
  enabled boolean not null default true,
  priority int not null default 50,
  mode text not null default 'both' check (mode in ('tool','listener','both')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Playbook: collections (bundles of scenarios a campaign matches against) ──
create table if not exists public.listener_collections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.listener_collection_handlers (
  collection_id uuid not null references public.listener_collections(id) on delete cascade,
  handler_id uuid not null references public.listener_handlers(id) on delete cascade,
  primary key (collection_id, handler_id)
);

-- ── Scripts (a flow: boxes + arrows) ────────────────────────────────────────
create table if not exists public.listener_scripts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  collection_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.listener_script_nodes (
  id uuid primary key,                        -- client-generated; NOT default
  script_id uuid not null references public.listener_scripts(id) on delete cascade,
  type text not null,
  scenario_id uuid,
  label text not null default '',
  config jsonb not null default '{}'::jsonb,  -- connectors, statements, collectionId, waitSeconds…
  pos_x double precision not null default 0,
  pos_y double precision not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.listener_script_edges (
  id uuid primary key,                        -- client-generated
  script_id uuid not null references public.listener_scripts(id) on delete cascade,
  source_node_id uuid not null,
  target_node_id uuid not null,
  condition jsonb not null default '{}'::jsonb, -- {kind:'intent'|'any'|'timeout', by, value, handle:'c:<uuid>'}
  label text not null default '',
  created_at timestamptz not null default now()
);

-- ── Per-call audit log (powers the QA "Script timeline" surface) ────────────
create table if not exists public.lab_call_events (
  id bigint generated always as identity primary key,  -- row id IS the ordering anchor
  call_id text not null,
  event_type text not null,   -- utterance|agent_said|classified|speculated|injected|skipped|error|sms|status
  role text,
  content text,
  intent_key text,
  confidence double precision,
  handler_id uuid,
  action_type text,
  utterance_at timestamptz,
  received_at timestamptz not null default now(),
  classified_at timestamptz,
  injected_at timestamptz,
  latency_ms int,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_lab_call_events_call on public.lab_call_events(call_id, id);

-- ── Per-call flow position (optimistic-locked on updated_at) ────────────────
create table if not exists public.lab_call_flow_state (
  call_id text primary key,
  script_id uuid,
  current_node_id uuid,
  variables jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()   -- optimistic-lock token
);

-- ── Builder-level defaults (per-campaign config lives on campaigns_v2) ──────
create table if not exists public.lab_settings (
  id text primary key default 'default',
  lab_assistant_id text,
  short_prompt text,
  router_model text not null default 'gpt-4o-mini',
  confidence_threshold double precision not null default 0.6,
  injection_cooldown_ms int not null default 0,
  trigger_response boolean not null default true,
  server_url_override text,
  active_collection_id uuid,
  active_script_id uuid,
  updated_at timestamptz not null default now()
);

-- ── RLS: permissive (browser anon reads/writes; campaigns_v2 precedent) ─────
alter table public.listener_handlers            enable row level security;
alter table public.listener_collections         enable row level security;
alter table public.listener_collection_handlers enable row level security;
alter table public.listener_scripts             enable row level security;
alter table public.listener_script_nodes        enable row level security;
alter table public.listener_script_edges        enable row level security;
alter table public.lab_call_events              enable row level security;
alter table public.lab_call_flow_state          enable row level security;
alter table public.lab_settings                 enable row level security;

drop policy if exists "Allow all on listener_handlers"            on public.listener_handlers;
drop policy if exists "Allow all on listener_collections"         on public.listener_collections;
drop policy if exists "Allow all on listener_collection_handlers" on public.listener_collection_handlers;
drop policy if exists "Allow all on listener_scripts"             on public.listener_scripts;
drop policy if exists "Allow all on listener_script_nodes"        on public.listener_script_nodes;
drop policy if exists "Allow all on listener_script_edges"        on public.listener_script_edges;
drop policy if exists "Allow all on lab_call_events"              on public.lab_call_events;
drop policy if exists "Allow all on lab_call_flow_state"          on public.lab_call_flow_state;
drop policy if exists "Allow all on lab_settings"                 on public.lab_settings;

create policy "Allow all on listener_handlers"            on public.listener_handlers            for all using (true) with check (true);
create policy "Allow all on listener_collections"         on public.listener_collections         for all using (true) with check (true);
create policy "Allow all on listener_collection_handlers" on public.listener_collection_handlers for all using (true) with check (true);
create policy "Allow all on listener_scripts"             on public.listener_scripts             for all using (true) with check (true);
create policy "Allow all on listener_script_nodes"        on public.listener_script_nodes        for all using (true) with check (true);
create policy "Allow all on listener_script_edges"        on public.listener_script_edges        for all using (true) with check (true);
create policy "Allow all on lab_call_events"              on public.lab_call_events              for all using (true) with check (true);
create policy "Allow all on lab_call_flow_state"          on public.lab_call_flow_state          for all using (true) with check (true);
create policy "Allow all on lab_settings"                 on public.lab_settings                 for all using (true) with check (true);

-- Seed the singleton settings row so getLabSettings() always resolves.
insert into public.lab_settings (id) values ('default') on conflict (id) do nothing;
