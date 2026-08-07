-- 2026-08-07 — Fourth SMS consent mode: 'optin_reached_only' (Val, relayed +
-- confirmed by Jasiel 2026-08-07).
--
-- Run in the Supabase SQL Editor BEFORE deploying the matching code. Apply-first
-- is the protocol for the same hard reason as the VOZ-245 migration: the CHECK
-- constraint below only allows the previous three values, so until this runs,
-- ANY campaign create/edit that selects the new mode fails the write outright.
-- (Deploy-order safety in the other direction is already built in: if the code
-- ever rolls back while a row holds the new value, resolveSmsConsentMode coerces
-- unknown modes to verbal_yes — the most-gated policy.)
--
--   optin_reached_only — same consent basis as the other opt-in modes (the
--                      player ticked "Receive SMS Promos" at registration), but
--                      the trigger is the dashboard's own attempt tag:
--                        • positive / neutral / declined  → text (one per player)
--                        • voicemail                      → never texted
--                        • early hang-up (dead-air pickup)→ never texted
--                        • agent timeout (pipeline death) → never texted (redial owed)
--                        • unreached                      → never texted, and NO
--                          last-resort text either (Val: "we shouldn't send SMS
--                          to the people that we didn't manage to reach")
--                      An on-call SMS refusal ("don't text me") does NOT veto —
--                      literal-Val rule, Jasiel chose it 2026-08-07 over
--                      promoting emphatic refusals to DNC. The "stop calling"
--                      opt-out still vetoes everything and auto-suppresses.
--
-- Why this mode exists: Val drilled the Early hang-up filter on a campaign
-- (2026-08-06 AU reactivation child) and found texted players there — under
-- optin_any_pickup, dead-air pickups and undetected machines were "reached".
-- This mode reuses deriveAttemptTag as the dispatch trigger, so an SMS can
-- never appear under a dashboard bucket the policy refuses to text.
--
-- Existing campaigns are untouched: no default change, no data migration.

do $$
declare
  c_name text;
begin
  -- Drop whatever the existing check is called rather than guessing the
  -- Postgres-generated name (same defensive shape as the VOZ-245 migration).
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
  check (sms_consent_mode in ('verbal_yes', 'registered_optin', 'optin_any_pickup', 'optin_reached_only'));

comment on column campaigns_v2.sms_consent_mode is
  'SMS dispatch policy: verbal_yes = consent evidence on the call required (default); registered_optin = registration opt-in, texts reached humans + voicemail follow-ups (2026-06-11 Val); optin_any_pickup = registration opt-in, texts EVERY answered line (2026-07-28 Val, VOZ-245); optin_reached_only = registration opt-in, texts only real conversations — never voicemail/dead-air/unreached, SMS refusal does not veto (2026-08-07 Val).';

-- Verify (expect the four values allowed, existing rows unchanged):
--   select sms_consent_mode, count(*) from campaigns_v2 group by 1 order by 1;
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conname = 'campaigns_v2_sms_consent_mode_check';
