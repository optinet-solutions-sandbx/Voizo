-- 2026-08-05 Campaign roster counts RPC — FINAL definition, as applied to prod.
--
-- WHY: /api/dashboard/campaigns read the ENTIRE campaign_numbers_v2 table through
-- fetchAllRows purely to COUNT rows per campaign in JS (`players`). At 26,655 rows
-- that is 27 sequential .range() round-trips, and fetchAllRows awaits them one at a
-- time — so the route's wall clock WAS that leg, not the rollup RPCs.
-- Measured 2026-08-05 against prod (voizo-eight.vercel.app, 3 probes each):
--   /api/qa-prompt-testing/campaigns  0.9-1.4s   (same lifetime dashboard_call_rollup, no roster leg)
--   /api/dashboard/campaigns          15.5-16.8s (+ sms rollup + 27-page roster leg)
-- Local leg timings: call rollup 0.53s, sms rollup 0.31s, campaigns_v2 0.08s,
-- roster 2.89s/27 pages. Both routes fit fixed + ~530ms per Vercel->Supabase
-- round-trip, so the cost is ROUND-TRIP COUNT, not query cost — which is why the
-- fix is one GROUP BY, not the persisted daily rollup table VOZ-289 speculated.
--
-- Deliberately NOT folded into dashboard_call_rollup: that function is
-- (campaign_id, day_utc)-grained over calls_v2, and a roster has no day dimension.
-- Keeping it separate also leaves the VOZ-283 rollup definitions untouched.
--
-- No index: hash-agg over 26k rows is single-digit ms, and campaign_id already
-- carries an FK index. No SECURITY DEFINER / explicit GRANT — matches the
-- dashboard_call_rollup / dashboard_sms_rollup precedent; the output is aggregate
-- counts only, strictly less sensitive than what those already return.
--
-- Safe to re-run (DROP-then-CREATE; a RETURNS TABLE shape change would reject
-- CREATE OR REPLACE with 42P13).
--
-- Consumer: /api/dashboard/campaigns via computeCampaignTableFromRollup's
-- playersByCampaign. `players` is a parity-gated field, so any change here MUST
-- re-run RUN_PARITY=1 npx vitest run src/lib/dashboardRollup.parity.test.ts before
-- the route ships it — the gate compares this COUNT against the JS row-count map.

DROP FUNCTION IF EXISTS public.campaign_roster_counts();
CREATE FUNCTION public.campaign_roster_counts()
RETURNS TABLE (campaign_id uuid, players int)
LANGUAGE sql STABLE AS $$
  -- Unfiltered by design: the JS it replaces counted EVERY campaign_numbers_v2 row
  -- per campaign (no outcome / is_test / ghost predicate). Campaign-level exclusions
  -- happen later, in computeCampaignTableFromRollup.
  -- count(*)::int (not bigint) mirrors the dashboard_call_rollup counts and keeps the
  -- JSON a plain number — a roster is ~26k rows, nowhere near int overflow.
  SELECT cn.campaign_id, count(*)::int AS players
  FROM public.campaign_numbers_v2 cn
  GROUP BY cn.campaign_id;
$$;
