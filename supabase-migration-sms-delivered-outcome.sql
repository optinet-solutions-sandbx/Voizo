-- Migration: add 'sms_delivered' to the campaign_numbers_v2.outcome CHECK constraint.
--
-- Why: the campaign-scheduler cron now retires a pending_retry number to outcome
-- 'sms_delivered' ("Reached via SMS") once its offer SMS is confirmed DELIVERED, so the
-- dialer stops re-calling someone who already has the offer link in their texts (a
-- registered_optin voicemail follow-up). Without this value in the CHECK list the
-- retirement UPDATE fails with Postgres 23514 (check_violation).
--
-- ORDER MATTERS: apply this to PROD *before* deploying the code that writes the value
-- (same rule as the 2026-06-19 call-observability migration). The new list is a strict
-- SUPERSET of the old one, so the re-added constraint validates every existing row
-- instantly and no in-flight write can be rejected.
--
-- Same DROP/ADD pattern + transaction wrap as supabase-migration-rebuild-phase-1.sql:53-62
-- (wrap so concurrent writers block on the ALTER lock rather than hitting a missing
-- constraint between the drop and the add).

begin;

alter table campaign_numbers_v2
  drop constraint campaign_numbers_v2_outcome_check;

alter table campaign_numbers_v2
  add constraint campaign_numbers_v2_outcome_check
    check (outcome in (
      'pending', 'in_progress', 'unreached', 'pending_retry', 'sent_sms',
      'sms_delivered',
      'not_interested', 'declined_offer', 'wrong_number', 'suppressed',
      'removed_from_segment', 'recently_called_elsewhere'
    ));

commit;

-- ── Rollback (manual; ONLY safe once no row has outcome='sms_delivered') ───────
-- begin;
-- alter table campaign_numbers_v2
--   drop constraint campaign_numbers_v2_outcome_check;
-- alter table campaign_numbers_v2
--   add constraint campaign_numbers_v2_outcome_check
--     check (outcome in (
--       'pending', 'in_progress', 'unreached', 'pending_retry', 'sent_sms',
--       'not_interested', 'declined_offer', 'wrong_number', 'suppressed',
--       'removed_from_segment', 'recently_called_elsewhere'
--     ));
-- commit;
