-- 2026-08-04_cost_tracking.sql
-- Budget guardrail: per-call cost ingestion + per-campaign budget cap.
-- (spend tracking design 2026-08-04; pairs with the cost estimator shipped e1b65be)
--
-- calls_v2.vapi_cost_usd    — Vapi's measured `cost` (USD) for the call.
--                             NOTE: excludes OpenAI (BYO org credential; Vapi
--                             reports llm=0 — verified by probe 2026-08-04).
-- calls_v2.openai_cost_usd  — our computed OpenAI cost: token-based when token
--                             rates are configured, else duration × the
--                             measured $0.032/talk-min blended rate.
-- campaigns_v2.budget_usd   — optional hard cap; scheduler pauses the campaign
--                             when campaign_spend_usd(id) reaches it.
--
-- All additive; no defaults backfilled (NULL = not yet ingested; the
-- recording-backfill cron sweeps NULLs for completed calls with a vapi_call_id).

alter table calls_v2 add column if not exists vapi_cost_usd numeric;
alter table calls_v2 add column if not exists openai_cost_usd numeric;

alter table campaigns_v2 add column if not exists budget_usd numeric
  check (budget_usd is null or budget_usd > 0);

-- Spend so far for one campaign. SQL aggregate (never select+reduce: 1000-row
-- PostgREST clamp). STABLE, read-only.
create or replace function campaign_spend_usd(p_campaign_id uuid)
returns numeric
language sql
stable
as $$
  select coalesce(sum(coalesce(vapi_cost_usd, 0) + coalesce(openai_cost_usd, 0)), 0)
  from calls_v2
  where campaign_id = p_campaign_id;
$$;
