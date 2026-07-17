-- ============================================================================
-- Player names on campaign contacts (greet-by-name Ramp 1, 2026-07-17, Jas-approved)
-- ============================================================================
-- Additive + nullable: campaign_numbers_v2 gains display_name, stored RAW as
-- Customer.io provides it. No backfill — historical rows stay NULL (recurring
-- children pick names up at their next spawn). Speech-boundary hygiene happens
-- in code (src/lib/playerName.ts cleanFirstName), never in SQL.
-- Rollback: alter table public.campaign_numbers_v2 drop column display_name;

alter table public.campaign_numbers_v2
  add column if not exists display_name text;
