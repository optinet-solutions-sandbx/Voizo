-- 2026-06-11 — Per-campaign SMS consent mode (Val/client pivot, GC thread).
-- Run in the Supabase SQL Editor BEFORE deploying the matching code
-- (the end-of-call webhook selects this column; it degrades to verbal_yes
-- with a warning if missing, but apply-first is the protocol).
--
--   verbal_yes        — today's behavior (DEFAULT): SMS only on goal_reached
--                       + consent evidence (native success or a genuine
--                       customer yes on the call).
--   registered_optin  — client-owned consent basis (players ticked "Receive
--                       SMS Promos" at registration): SMS sends when the
--                       agent announced a text on a live call. Voicemail,
--                       on-call decline ("don't text me"), opt-out, and the
--                       suppression list still veto in BOTH modes.
--
-- Existing campaigns keep verbal_yes (no behavior change without operator action).

alter table campaigns_v2
  add column if not exists sms_consent_mode text not null default 'verbal_yes'
  check (sms_consent_mode in ('verbal_yes', 'registered_optin'));

comment on column campaigns_v2.sms_consent_mode is
  'SMS dispatch policy: verbal_yes = consent evidence on the call required (default); registered_optin = client-attested registration opt-in, send on agent announce (2026-06-11 Val).';

-- Verify:
--   select sms_consent_mode, count(*) from campaigns_v2 group by 1;
