-- Export Reporting Phase 1 — additive migration
-- Design: docs/2026-05-25_DESIGN_Call_And_SMS_Export_Reporting.md
--
-- Adds:
--   calls_v2.recording_url  text   Vapi's public CDN URL for the call recording.
--                                  Populated from `artifact.recording.mono.combinedUrl`
--                                  by the end-of-call webhook (with legacy
--                                  `recordingUrl` fallback). Storage: storage.vapi.ai
--                                  (mono combined WAV by default).
--
-- Why: webhook handler at src/app/api/webhooks/vapi/end-of-call/route.ts
-- already receives the URL in the Vapi end-of-call payload but currently
-- discards it. Persisting it avoids per-call Vapi API re-fetches at export
-- time (Vapi support's own recommendation: cache URLs in your DB).
--
-- Non-destructive: nullable, no default, no existing-row backfill. Historical
-- calls (pre-migration) keep recording_url=NULL — the export UI surfaces
-- this as "audio available for calls completed after the migration date."
--
-- Run this in the Supabase SQL Editor against STAGING first, then prod
-- after the no-prod-commit-without-Chris check.

begin;

alter table calls_v2
  add column recording_url text;

commit;

-- ── Rollback (single transaction; only if no readers have started using it) ──
-- begin;
--   alter table calls_v2 drop column recording_url;
-- commit;
