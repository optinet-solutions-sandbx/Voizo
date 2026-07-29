-- VOZ-252: give a Script its own voice so the campaign clone is forced to the
-- SCRIPT's configured voice, not whatever the shared "Val" base assistant is
-- currently set to on the Vapi dashboard. Additive + idempotent (safe to re-run).
alter table listener_scripts add column if not exists voice_id text;

comment on column listener_scripts.voice_id is
  'ElevenLabs voiceId this script should speak with (from VOICE_OPTIONS). Source of truth for campaign-clone voice; null = inherit the base assistant voice (legacy behavior). VOZ-252.';
