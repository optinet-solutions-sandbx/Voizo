-- Per-brand SMS sender: record which originator every message went out under.
--
-- Why: SMS is dispatched per-brand now (originator resolved from the campaign's
-- cio_workspace via resolveSmsSenderId). Storing the sender on each row is what
-- lets the CRM team see, per message, which brand it came from — the gap that
-- made the Fortune Play "receipts look like Lucky7even" confusion hard to trace.
--
-- DEPLOY ORDER (hard requirement): run this BEFORE the code that writes
-- sms_messages_v2.sender_id ships. Both dispatch paths (processEndOfCall,
-- lastResortSweep) include sender_id in their status UPDATE. If the column is
-- absent when that UPDATE runs, the whole update fails and a just-sent message
-- is left stranded at status='queued'. Migration first, then deploy.
--
-- Nullable, no backfill: historical rows keep sender_id = NULL (we did not track
-- it then); every new message written after deploy carries its originator.

alter table public.sms_messages_v2
  add column if not exists sender_id text;

-- Rollback (only if reverting the code too, else new writes will fail):
-- alter table public.sms_messages_v2 drop column if exists sender_id;
