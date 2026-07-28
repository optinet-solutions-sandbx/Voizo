-- 2026-07-28 (VOZ-245) — Third SMS consent mode: 'optin_any_pickup' (Val).
--
-- Run in the Supabase SQL Editor BEFORE deploying the matching code. Apply-first
-- is the protocol here for a hard reason: the CHECK constraint added by
-- supabase-migration-sms-consent-mode.sql only allows ('verbal_yes',
-- 'registered_optin'), so until this runs, ANY campaign create/edit that selects
-- the new mode fails the write outright.
--
--   optin_any_pickup — same consent basis as registered_optin (the player ticked
--                      "Receive SMS Promos" at registration), but a LOWER trigger
--                      bar: every answered line gets the one text, regardless of
--                      how the conversation went — sluggish, incomprehensible,
--                      early hang-up, or answered-in-silence all count as reached.
--                      Val's ask, 2026-07-28: the offer link is the payload, and
--                      conversation quality is not a consent signal.
--
--                      Still vetoed, in this order: (1) an on-call "stop calling"
--                      (also auto-suppresses), (2) detected voicemail keeps its
--                      OWN branch so the last-resort setting still governs it,
--                      (3) an explicit "don't text me", (4) the suppression /
--                      Do-Not-Call list at send time. One text per player per
--                      campaign (unchanged per-player dedup).
--
-- Why this mode exists: measured on the 2026-07-27/28 realtime run, verbal_yes
-- sent 6 texts against 14 real human conversations that had heard the SMS offer,
-- because it gates on goal_reached, which on SIP comes only from an explicit
-- assent word landing within 4 turns. registered_optin would have sent 201;
-- this mode sends 230 (the extra 29 are pickups where nobody spoke).
--
-- Existing campaigns are untouched: no default change, no data migration.

do $$
declare
  c_name text;
begin
  -- Drop whatever the existing check is called rather than guessing the
  -- Postgres-generated name (it is campaigns_v2_sms_consent_mode_check today,
  -- but a rename would make a hardcoded DROP silently no-op and then the ADD
  -- below would fail on the stale two-value constraint).
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'campaigns_v2'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%sms_consent_mode%'
  limit 1;

  if c_name is not null then
    execute format('alter table campaigns_v2 drop constraint %I', c_name);
  end if;
end $$;

alter table campaigns_v2
  add constraint campaigns_v2_sms_consent_mode_check
  check (sms_consent_mode in ('verbal_yes', 'registered_optin', 'optin_any_pickup'));

comment on column campaigns_v2.sms_consent_mode is
  'SMS dispatch policy: verbal_yes = consent evidence on the call required (default); registered_optin = registration opt-in, texts reached humans + voicemail follow-ups (2026-06-11 Val); optin_any_pickup = registration opt-in, texts EVERY answered line regardless of conversation quality (2026-07-28 Val, VOZ-245).';

-- Verify (expect the three values allowed, existing rows unchanged):
--   select sms_consent_mode, count(*) from campaigns_v2 group by 1 order by 1;
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'campaigns_v2_sms_consent_mode_check';
