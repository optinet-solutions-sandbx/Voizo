-- SMS last-resort mode (VOZ-132 spec §8 — approved to build 2026-07-10, Maria
-- sign-off on wording is a meeting-notes item; the text body is operator-
-- editable at campaign creation). Apply BEFORE deploying the sms-last-resort
-- build. Apply to voizo-sandbox (staging) FIRST, confirm, then prod.
--
-- ONE nullable column; THE COLUMN IS THE FLAG:
--   NULL / empty  -> today's behavior byte-for-byte (every existing campaign):
--                    registered_optin voicemails get the instant follow-up text.
--   non-empty     -> last-resort mode for that campaign:
--                    (a) voicemails re-dial instead of texting instantly
--                        (end-of-call webhook, decideSmsDispatch lastResortMode)
--                    (b) after the LAST failed try (outcome unreached at
--                        max_attempts) the scheduler sends this template ONCE
--                        (campaign-scheduler last-resort sweep).
-- verbal_yes campaigns never use this in either half (no spoken yes = no text).
alter table public.campaigns_v2
  add column if not exists sms_last_resort_template text;
