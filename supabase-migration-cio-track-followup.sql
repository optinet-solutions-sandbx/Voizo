-- Email follow-up channel: CIO identity carry-through + the outbound-event ledger.
-- Plan: .agent/tasks/2026-09-01_PLAN_Email_Followup_Track_Event.md
-- Pattern: additive + default-deny RLS (matches realtime_seen_members / cio_events).
-- 🔴 APPLY BEFORE DEPLOYING this build. The realtime-admission insert names the new column;
--    deploying first would make every insert fail, release the claim, and retry forever.
-- Apply to voizo-sandbox (staging) FIRST, confirm, then prod.

-- 1) The identity we have been throwing away at audience load. The Customer.io segment pull
--    returns cio_id with every member; campaign_numbers_v2 kept phone only, so at dispatch time
--    we held nothing addressable in CIO. Nullable on purpose: wizard-pasted numbers and ghost
--    campaigns have no CIO identity, and historical rows resolve at dispatch time through
--    realtime_seen_members (18,125 rows, 100% cio_id+phone).
alter table public.campaign_numbers_v2
  add column if not exists cio_id text;

-- 2) The outbound-event ledger. One row per follow-up event we ASK Customer.io to process.
--    State is written BEFORE the provider call (the sms_messages_v2 §6 pattern): a crash between
--    insert and send leaves 'queued', which is visible and safe — never a silent double-send.
--
--    NO foreign keys, deliberately: this is an audit/compliance record ("we triggered a promo
--    email to this player"). Deleting a campaign must never erase the evidence the email was
--    triggered. Same posture as cio_events.
create table if not exists public.cio_track_events (
  id                 uuid        primary key default gen_random_uuid(),
  -- resolved from campaigns_v2.cio_workspace at dispatch; picks the Track key
  workspace          text        not null,
  cio_id             text        not null,
  event_name         text        not null,
  campaign_id        uuid,
  campaign_number_id uuid        not null,
  call_id            uuid,
  -- queued = ledger row written, provider not yet called (crash window, visible)
  -- sent   = Track API accepted (2xx)
  -- failed = Track API refused or timed out; does NOT hold the dedupe door (see index)
  status             text        not null default 'queued'
    check (status in ('queued','sent','failed')),
  error              text,
  created_at         timestamptz not null default now(),
  sent_at            timestamptz
);

alter table public.cio_track_events enable row level security;
-- default-deny: no policies. Server-side access uses the service role.

-- THE one-email-per-player door, at the database so a concurrent-webhook race cannot slip
-- through (TOCTOU) — same trick as uniq_sms_per_campaign_number. Partial: a 'failed' attempt
-- must not permanently burn the player's one follow-up, exactly like the SMS rule.
-- 'queued' DOES hold the door: a crashed-after-insert row blocks a second send until a human
-- (or a later sweep) resolves it — the safe direction for an irreversible outbound action.
create unique index if not exists uniq_followup_per_contact
  on public.cio_track_events (campaign_number_id, event_name)
  where status <> 'failed';

-- Read paths: the Audience drawer timeline (per player) and per-campaign reporting.
create index if not exists cio_track_events_cio_id_idx      on public.cio_track_events (cio_id);
create index if not exists cio_track_events_campaign_id_idx on public.cio_track_events (campaign_id);

-- Verify:
--   select column_name from information_schema.columns
--     where table_name = 'campaign_numbers_v2' and column_name = 'cio_id';
--   select indexname from pg_indexes where tablename = 'cio_track_events';
--   select count(*) from cio_track_events;   -- 0 until the first follow-up fires
