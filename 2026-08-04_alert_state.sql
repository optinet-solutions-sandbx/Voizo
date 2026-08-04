-- 2026-08-04_alert_state.sql
-- VOZ-279: dedupe state for platform-wide anomaly alerts (AI pipeline burst,
-- connect collapse). One row per detector key; the scheduler re-alerts at most
-- once per hour per key while a condition persists (shouldAlertSpawnFail
-- predicate, windowMs = 1h).
-- RLS enabled with no policies = service-role-only access (house rule for
-- every new public table, even service-role-only ones).

create table if not exists alert_state (
  key text primary key,
  last_alerted_at timestamptz not null
);

alter table alert_state enable row level security;
