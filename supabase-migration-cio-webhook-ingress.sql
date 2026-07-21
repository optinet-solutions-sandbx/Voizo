-- Customer.io webhook ingress (VOZ-180 —
-- docs/2026-07-21_SPEC_CustomerIO_Webhook_Ingress.md). Apply BEFORE deploying
-- the ingress build: the shared admission core (realtimeAdmission.ts) writes
-- display_name on every claim, so an un-migrated DB would fail every claim.
-- Pattern: additive only. Apply to voizo-sandbox (staging) FIRST, then prod.

-- Player name captured at claim time (greet-by-name). Before this column,
-- members passing through 'waiting' (operator call delay — and now the
-- webhook lane's off-hours/cap-full buffer) lost their name and could not be
-- greeted personally: the promotion pass had nowhere to read it from.
alter table public.realtime_seen_members
  add column if not exists display_name text;

-- No RLS change: realtime_seen_members is already default-deny (no policies;
-- service-role access only) per supabase-migration-realtime-campaigns.sql.
