-- Migration: campaigns_v2.last_swept_at — resume-sweep rotation stamp (2026-06-10)
--
-- WHY: the campaign-scheduler resume sweep serves idle running campaigns under a
-- wall-clock budget (RESUME_FIRE_BUDGET_MS). It ordered by updated_at asc with no
-- rotation, so under sustained budget pressure the same oldest campaigns are served
-- first every tick — campaigns ranked 4th+ can starve once CAMPAIGN_CONCURRENCY_LIMIT
-- is raised 3 → 5, and a campaign whose fireCall always fails pins the front of the
-- queue forever (fire_failed never changed its rank).
--
-- WHAT: a nullable timestamp the sweep stamps immediately BEFORE each fire attempt
-- (write-before-fire ROTATION STAMP — success, failure, or a mid-fire timeout all
-- rotate the campaign to the back; it is NOT a lock/lease and provides no mutual
-- exclusion — tick-overlap dedupe rests on the sweep's in-flight check). The sweep
-- orders by last_swept_at ASC NULLS FIRST (never-swept first), tiebreak updated_at.
--
-- DELIBERATELY NOT campaigns_v2.last_resumed_at: that column pre-exists
-- (supabase-migration-rebuild-phase-1.sql:37, "analytics + diff base on resume") and
-- is written by the OPERATOR resume/rebind path (src/lib/vapi/rebindCore.ts) — it
-- pairs with last_paused_at for pause-duration telemetry. A per-minute sweep stamp
-- would overwrite that record, so the sweep gets its own column.
--
-- Additive + idempotent; no default, no index (the sweep reads ≤20 running rows);
-- non-PII. The existing trg_campaigns_v2_updated_at trigger also bumps updated_at on
-- the sweep's stamp — accepted; the stamp UPDATE is guarded with status='running' so
-- it can never touch a terminal row (heartbeat Rule-2's 10-min terminal clock).
--
-- Apply BEFORE deploying the code, then CONFIRM the column exists in prod before
-- pushing (e.g. GET /rest/v1/campaigns_v2?select=last_swept_at&limit=1 → 200).
-- Early deploy degrades gracefully in the scheduler (its ordered select errors →
-- resumes skip that tick, the rest of the cron runs) but the heartbeat's
-- stuck-report select would 500 its tick until applied — hence apply-first.

alter table campaigns_v2 add column if not exists last_swept_at timestamptz;

comment on column campaigns_v2.last_swept_at is
  'Resume-sweep rotation stamp: when the sweep last attempted a fire for this campaign (stamped pre-fire, status-running-guarded). NULL = never swept. Ordering key for sweep fairness; NOT operator resume time (that is last_resumed_at, written by rebindCore).';
