-- Campaign V2: dial → AI converses → SMS on goal reached
-- Run this in the Supabase SQL Editor.
--
-- Design notes:
--   - Provider-agnostic: Twilio is the temporary dialer. Store provider + provider_call_id
--     so we can swap telephony later without a schema migration.
--   - Webhook-driven: sequential dialing is triggered by Twilio call.completed webhooks,
--     not an in-process queue (Vercel is serverless).
--   - SMS fires only when goal_reached = true (not on every call end).
--   - Suppression list is checked before every dial. Non-negotiable.

-- ── 1. Suppression list (DNC) ──────────────────────────────────
create table suppression_list (
  id uuid default gen_random_uuid() primary key,
  phone_e164 text not null unique,
  reason text,
  added_by text,
  added_at timestamptz default now() not null
);

create index idx_suppression_phone on suppression_list(phone_e164);

-- ── 2. Campaigns V2 ────────────────────────────────────────────
create table campaigns_v2 (
  id uuid default gen_random_uuid() primary key,
  name text not null,

  -- Agent configuration (Vapi)
  vapi_assistant_id text not null,
  vapi_assistant_name text,
  system_prompt text not null,

  -- Scheduling
  timezone text not null default 'America/Toronto',
  start_at timestamptz,
  end_at timestamptz,
  -- call_windows is a JSONB array of { day: 'sun'..'sat', start: 'HH:MM', end: 'HH:MM' }
  -- Example seeded from Callers.ai: Sun-Mon 12-20, Tue-Thu 12-17, Fri 18-20, Sat 12-20
  call_windows jsonb not null default '[]'::jsonb,

  -- Retry policy (defaults match Callers.ai: 3 attempts, 90-minute interval)
  max_attempts int not null default 3,
  retry_interval_minutes int not null default 90,

  -- Post-call SMS
  sms_enabled boolean not null default false,
  sms_template text,
  sms_on_goal_reached_only boolean not null default true,

  -- Lifecycle
  status text not null default 'draft'
    check (status in ('draft', 'running', 'paused', 'completed', 'archived')),

  created_by text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_campaigns_v2_status on campaigns_v2(status);

-- ── 3. Campaign numbers (one row per phone number per campaign) ─
create table campaign_numbers_v2 (
  id uuid default gen_random_uuid() primary key,
  campaign_id uuid references campaigns_v2(id) on delete cascade not null,
  phone_e164 text not null,

  -- Attempt tracking
  attempt_count int not null default 0,
  last_attempted_at timestamptz,
  next_attempt_at timestamptz,

  -- Outcome: mirrors Callers.ai labels so reports are consistent
  --   pending, in_progress, unreached, pending_retry, sent_sms,
  --   not_interested, declined_offer, wrong_number, suppressed
  outcome text not null default 'pending'
    check (outcome in (
      'pending','in_progress','unreached','pending_retry','sent_sms',
      'not_interested','declined_offer','wrong_number','suppressed'
    )),

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,

  unique (campaign_id, phone_e164)
);

create index idx_campaign_numbers_campaign on campaign_numbers_v2(campaign_id);
create index idx_campaign_numbers_next_attempt on campaign_numbers_v2(campaign_id, next_attempt_at)
  where outcome in ('pending','pending_retry');

-- ── 4. Calls (one row per call attempt) ────────────────────────
create table calls_v2 (
  id uuid default gen_random_uuid() primary key,
  campaign_id uuid references campaigns_v2(id) on delete cascade not null,
  campaign_number_id uuid references campaign_numbers_v2(id) on delete cascade not null,

  -- Provider-agnostic
  provider text not null default 'twilio',
  provider_call_id text,                  -- Twilio Call SID lives here

  -- Outcome
  status text not null default 'initiated'
    check (status in (
      'initiated','ringing','in_progress','answered','completed',
      'no_answer','busy','failed','voicemail','canceled'
    )),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int,

  -- Vapi results (populated via /api/webhooks/vapi/end-of-call)
  vapi_call_id text,
  transcript jsonb,
  goal_reached boolean,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_calls_v2_campaign on calls_v2(campaign_id);
create index idx_calls_v2_number on calls_v2(campaign_number_id);
create index idx_calls_v2_provider on calls_v2(provider, provider_call_id);

-- ── 5. SMS messages (one row per SMS sent) ─────────────────────
create table sms_messages_v2 (
  id uuid default gen_random_uuid() primary key,
  campaign_id uuid references campaigns_v2(id) on delete cascade not null,
  call_id uuid references calls_v2(id) on delete set null,
  campaign_number_id uuid references campaign_numbers_v2(id) on delete cascade not null,

  -- Provider-agnostic (mobivate | twilio)
  provider text not null,
  provider_message_id text,

  to_phone_e164 text not null,
  body text not null,

  status text not null default 'queued'
    check (status in ('queued','sent','delivered','failed','undelivered')),
  error_message text,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

create index idx_sms_v2_campaign on sms_messages_v2(campaign_id);
create index idx_sms_v2_call on sms_messages_v2(call_id);
create index idx_sms_v2_provider on sms_messages_v2(provider, provider_message_id);

-- ── 6. updated_at trigger (keeps updated_at fresh on UPDATE) ────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_campaigns_v2_updated_at
  before update on campaigns_v2
  for each row execute function set_updated_at();

create trigger trg_campaign_numbers_v2_updated_at
  before update on campaign_numbers_v2
  for each row execute function set_updated_at();

create trigger trg_calls_v2_updated_at
  before update on calls_v2
  for each row execute function set_updated_at();

create trigger trg_sms_messages_v2_updated_at
  before update on sms_messages_v2
  for each row execute function set_updated_at();

-- ── 7. RLS (permissive for now — matches existing tables) ──────
alter table suppression_list    enable row level security;
alter table campaigns_v2        enable row level security;
alter table campaign_numbers_v2 enable row level security;
alter table calls_v2            enable row level security;
alter table sms_messages_v2     enable row level security;

create policy "Allow all on suppression_list"    on suppression_list    for all using (true) with check (true);
create policy "Allow all on campaigns_v2"        on campaigns_v2        for all using (true) with check (true);
create policy "Allow all on campaign_numbers_v2" on campaign_numbers_v2 for all using (true) with check (true);
create policy "Allow all on calls_v2"            on calls_v2            for all using (true) with check (true);
create policy "Allow all on sms_messages_v2"     on sms_messages_v2     for all using (true) with check (true);
