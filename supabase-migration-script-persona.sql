-- VOZ-188: per-script persona.
-- The Script Builder's Configuration drawer edits it, ▶ test calls speak it,
-- and the campaign wizard shows it read-only when the script is picked —
-- "what you tested is what launches".
--
-- '' (default) = legacy behavior: the lab falls back to the Playbook identity
-- scenario / lab_settings.short_prompt, and campaigns fall back to the
-- engine's built-in default persona.
--
-- Additive and idempotent — safe to run BEFORE the code deploy (required:
-- the deploy writes this column on Save Configuration).

ALTER TABLE listener_scripts
  ADD COLUMN IF NOT EXISTS persona text NOT NULL DEFAULT '';
