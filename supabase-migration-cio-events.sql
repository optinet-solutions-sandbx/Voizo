-- Customer.io event ingress (VOZ-454, route A).
-- Spec: .agent/tasks/2026-09-01_SPEC_VOZ454_CIO_Event_Ingress.md
-- Pattern: new table + default-deny RLS (matches realtime_seen_members / qa_scores / cron_heartbeats).
-- APPLY BEFORE DEPLOYING the route, or every insert 500s.
-- Apply to voizo-sandbox (staging) FIRST, confirm, then prod.
--
-- WHY: deposit figures on the Audience surface come from a MANUAL Activities capture today, and the
-- Customer.io Activities window is ~30 days and rolls strictly (measured: windowOldest moved +6 days
-- over 6 days, 08-19 -> 08-25). One day of player history is lost per day this is not live. Events
-- that arrive by webhook land here and never expire.

create table if not exists public.cio_events (
  -- The BRAND, taken from the signing key that verified the delivery — never from the request body.
  -- Trusting the body would let a valid signature from one workspace write rows attributed to another.
  workspace     text        not null,
  -- Customer.io's opaque person id, {{customer.cio_id}}. Joins to realtime_seen_members.cio_id
  -- (18,125 rows, 100% populated) and from there to phone_e164 -> campaign_numbers_v2 -> calls_v2.
  -- NEVER join on email.
  cio_id        text        not null,
  event_name    text        not null,
  -- THE IDEMPOTENCY DOOR. Customer.io retries, and its UI has a Resend button, so duplicate
  -- deliveries are certain rather than hypothetical. `payment_code` when the event carries one,
  -- else a deterministic hash of (cio_id, event_name, occurred_at).
  -- Stated ceiling: two genuinely distinct NON-deposit events in the same second for one player
  -- would collapse into one row. Money events carry payment_code, and a same-second repeat on a
  -- neutral event is a retry in practice. Revisit only if a real collision is observed.
  dedupe_key    text        not null,
  occurred_at   timestamptz not null,
  -- Provenance, so a chart can never silently claim a receipt time is an event time. 'received'
  -- means the payload's timestamp was absent or unparseable and this is OUR clock instead.
  occurred_at_source text   not null default 'payload'
    check (occurred_at_source in ('payload','received')),
  received_at   timestamptz not null default now(),
  -- Normalised total, comparable across currencies. NULL when the payload did not carry a
  -- parseable one — a missing field is stored as unknown, never as zero.
  amount_norm   numeric,
  currency      text,
  -- Customer.io sends the local-currency amount as a STRING. Kept verbatim as text and never
  -- coerced: the Audience surface holds one figure per currency and must never add AUD to CAD.
  amount_local  text,
  -- The delivery as received, MINUS the denylist scrub (bin / ip / phone / email / card / pan —
  -- see cioEventPayload.ts). Keeping the raw shape means a newly-relevant field needs no migration,
  -- and it is how we learn the true payload shape instead of trusting documentation.
  payload       jsonb       not null,
  primary key (workspace, event_name, dedupe_key)
);

alter table public.cio_events enable row level security;
-- default-deny: no policies. Server-side access uses the service role.

-- Read paths: "this player's events" (drawer timeline) and "events in a window" (rollup tiles).
create index if not exists cio_events_cio_id_idx      on public.cio_events (cio_id);
create index if not exists cio_events_occurred_at_idx on public.cio_events (occurred_at desc);

-- Verify:
--   select table_name from information_schema.tables where table_name = 'cio_events';
--   select indexname from pg_indexes where tablename = 'cio_events';
--   select count(*) from cio_events;   -- 0 until the first Customer.io delivery
