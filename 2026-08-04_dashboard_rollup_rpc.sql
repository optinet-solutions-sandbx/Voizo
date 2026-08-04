-- 2026-08-04 Dashboard SQL rollup RPCs (VOZ-283) — FINAL definitions, as applied to prod.
-- This file consolidates the working drafts from .agent/tasks/ (gitignored) into the
-- tracked repo root so the deployed functions' source of truth survives the laptop:
--   2026-08-03_SQL_dashboard_rollup.sql            (base: functions + indexes)
--   2026-08-04_SQL_call_rollup_successful_fix.sql   (adds `successful` — ungated goal count)
--   2026-08-04_SQL_call_rollup_vm_evaluated_fix.sql (adds `voicemail_evaluated`)
--   2026-08-04_SQL_sms_rollup_fix.sql               (SMS tag order = deriveAttemptTag)
-- ALREADY APPLIED to prod 2026-08-04 (verified via scripts/_probe-rollup-parity.cjs:
-- both RPCs return this exact shape). Safe to re-run: indexes are IF NOT EXISTS;
-- functions DROP-then-CREATE (RETURNS TABLE shape changes reject CREATE OR REPLACE, 42P13).
--
-- Consumers: /api/dashboard/today + /api/dashboard/campaigns via
-- computeTodayFromRollup / computeCampaignTableFromRollup (dashboardAnalytics.ts).
-- Byte-parity with the raw-rows path is enforced by src/lib/dashboardRollup.parity.test.ts
-- (RUN_PARITY=1 — hits live prod). Definitions mirror the LOCKED JS rules:
-- CONNECTED_STATUSES / TERMINAL_NONCONNECT (campaignAnalytics.ts) and the lean
-- (transcript-less) isEarlyHangup with EARLY_HANGUP_SEC = 15 (analyticsConfig.ts).
-- Any change here MUST re-run the parity gate before the routes ship it.

-- Indexes (idempotent, additive) ------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_calls_v2_created_at ON public.calls_v2 (created_at);
CREATE INDEX IF NOT EXISTS idx_calls_v2_campaign_created ON public.calls_v2 (campaign_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_v2_created_at ON public.sms_messages_v2 (created_at);

-- CALL ROLLUP -------------------------------------------------------------------
-- One row per (campaign_id, day_utc). Ghost/test campaigns excluded in SQL.
-- Bucket precedence mirrors callWindowBreakdown: voicemail (goal-overridden) →
-- positive → declined → early_hangup(lean) → neutral, over connected calls.
-- `successful` = goal_reached IS TRUE with NO connected gate (accumulate() parity).
-- `voicemail_evaluated` = connected calls with a NON-NULL voicemail flag.
DROP FUNCTION IF EXISTS public.dashboard_call_rollup(timestamptz, timestamptz);
CREATE FUNCTION public.dashboard_call_rollup(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  campaign_id uuid, day_utc date,
  attempts int, terminal int, connected int, voicemail int, voicemail_evaluated int, reach int,
  positive int, declined int, early_hangup_lean int, neutral_lean int,
  successful int,
  last_call_at timestamptz
)
LANGUAGE sql STABLE AS $$
  WITH tagged AS (
    SELECT
      c.campaign_id,
      c.created_at,
      (c.created_at AT TIME ZONE 'UTC')::date AS day_utc,
      (c.status IN ('completed','answered'))                                        AS is_connected,
      (c.status IN ('completed','answered','no_answer','busy','failed','canceled')) AS is_terminal,
      (c.goal_reached IS TRUE)                                                      AS is_goal,
      (c.voicemail IS NOT NULL)                                                     AS vm_evaluated,
      CASE
        WHEN c.status NOT IN ('completed','answered') THEN 'notconnected'
        WHEN c.voicemail IS TRUE AND c.goal_reached IS NOT TRUE THEN 'voicemail'
        WHEN c.goal_reached IS TRUE THEN 'positive'
        WHEN n.outcome = 'declined_offer' THEN 'declined'
        WHEN c.ended_reason = 'silence-timed-out'
             OR (c.duration_seconds IS NOT NULL AND c.duration_seconds < 15) THEN 'early_hangup'
        ELSE 'neutral'
      END AS bucket
    FROM public.calls_v2 c
    JOIN public.campaigns_v2 cp
      ON cp.id = c.campaign_id
     AND cp.source IS DISTINCT FROM 'ghost_portal'
     AND cp.is_test IS NOT TRUE
    LEFT JOIN public.campaign_numbers_v2 n ON n.id = c.campaign_number_id
    WHERE c.created_at >= p_start AND c.created_at < p_end
  )
  SELECT
    campaign_id, day_utc,
    COUNT(*)::int                                                    AS attempts,
    COUNT(*) FILTER (WHERE is_terminal)::int                         AS terminal,
    COUNT(*) FILTER (WHERE is_connected)::int                        AS connected,
    COUNT(*) FILTER (WHERE bucket = 'voicemail')::int                AS voicemail,
    COUNT(*) FILTER (WHERE is_connected AND vm_evaluated)::int       AS voicemail_evaluated,
    COUNT(*) FILTER (WHERE bucket IN ('positive','declined','early_hangup','neutral'))::int AS reach,
    COUNT(*) FILTER (WHERE bucket = 'positive')::int                 AS positive,
    COUNT(*) FILTER (WHERE bucket = 'declined')::int                 AS declined,
    COUNT(*) FILTER (WHERE bucket = 'early_hangup')::int             AS early_hangup_lean,
    COUNT(*) FILTER (WHERE bucket = 'neutral')::int                  AS neutral_lean,
    COUNT(*) FILTER (WHERE is_goal)::int                             AS successful,
    MAX(created_at)                                                  AS last_call_at
  FROM tagged
  GROUP BY campaign_id, day_utc;
$$;

-- SMS ROLLUP --------------------------------------------------------------------
-- One row per (campaign_id, day_utc). Sent = status IN ('sent','delivered').
-- Each sent SMS classified by its recipient call's tag (join sms.call_id -> calls.id);
-- unmatched SMS count in `sent` only. Tag order mirrors deriveAttemptTag EXACTLY:
-- positive (goal wins over everything, even non-connected — Val 2026-07-03/07-06) →
-- unreachable (not connected, even with the voicemail flag set) → voicemail →
-- declined → early_hangup/neutral. early_hangup folds into `reached` (no sub-row).
DROP FUNCTION IF EXISTS public.dashboard_sms_rollup(timestamptz, timestamptz);
CREATE FUNCTION public.dashboard_sms_rollup(p_start timestamptz, p_end timestamptz)
RETURNS TABLE (
  campaign_id uuid, day_utc date,
  sent int, reached int, voicemail int, unreachable int,
  positive int, neutral int, declined int
)
LANGUAGE sql STABLE AS $$
  WITH tagged AS (
    SELECT
      m.campaign_id,
      (m.created_at AT TIME ZONE 'UTC')::date AS day_utc,
      c.id AS call_id,
      (c.status IN ('completed','answered'))                    AS is_connected,
      (c.voicemail IS TRUE)                                     AS has_voicemail_flag,
      c.goal_reached, n.outcome AS contact_outcome, c.ended_reason, c.duration_seconds
    FROM public.sms_messages_v2 m
    JOIN public.campaigns_v2 cp
      ON cp.id = m.campaign_id
     AND cp.source IS DISTINCT FROM 'ghost_portal'
     AND cp.is_test IS NOT TRUE
    LEFT JOIN public.calls_v2 c ON c.id = m.call_id
    LEFT JOIN public.campaign_numbers_v2 n ON n.id = c.campaign_number_id
    WHERE m.status IN ('sent','delivered')
      AND m.created_at >= p_start AND m.created_at < p_end
  ), classified AS (
    SELECT campaign_id, day_utc,
      CASE
        WHEN call_id IS NULL THEN 'unmatched'
        WHEN goal_reached IS TRUE THEN 'positive'
        WHEN NOT is_connected THEN 'unreachable'
        WHEN has_voicemail_flag THEN 'voicemail'
        WHEN contact_outcome = 'declined_offer' THEN 'declined'
        WHEN ended_reason = 'silence-timed-out'
             OR (duration_seconds IS NOT NULL AND duration_seconds < 15) THEN 'early_hangup'
        ELSE 'neutral'
      END AS tag
    FROM tagged
  )
  SELECT campaign_id, day_utc,
    COUNT(*)::int                                                                        AS sent,
    COUNT(*) FILTER (WHERE tag IN ('positive','neutral','declined','early_hangup'))::int AS reached,
    COUNT(*) FILTER (WHERE tag = 'voicemail')::int                                       AS voicemail,
    COUNT(*) FILTER (WHERE tag = 'unreachable')::int                                     AS unreachable,
    COUNT(*) FILTER (WHERE tag = 'positive')::int                                        AS positive,
    COUNT(*) FILTER (WHERE tag = 'neutral')::int                                         AS neutral,
    COUNT(*) FILTER (WHERE tag = 'declined')::int                                        AS declined
  FROM classified
  GROUP BY campaign_id, day_utc;
$$;

-- Smoke (run after applying) ----------------------------------------------------
-- SELECT * FROM dashboard_call_rollup(now() - interval '2 days', now()) ORDER BY day_utc DESC LIMIT 20;
-- SELECT * FROM dashboard_sms_rollup(now() - interval '2 days', now()) ORDER BY day_utc DESC LIMIT 20;
