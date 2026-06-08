// GhostPortal env config + cost guardrails. Read at request time (not module load)
// so a value change takes effect on the next deploy without a stale-capture bug.

/** Dark-launch flag — the whole portal 404s when not 'true'. */
export const ghostPortalEnabled = () => process.env.GHOST_PORTAL_ENABLED === "true";

/** Min free SIP slots ghost must leave for production. Default 1 (never starve prod). */
export const ghostSlotReserve = () => {
  const n = parseInt(process.env.GHOST_SLOT_RESERVE ?? "1", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
};

/** Hard cap on targets per ghost run (cost guardrail). Default 2000. */
export const ghostMaxTargets = () => {
  const n = parseInt(process.env.GHOST_MAX_TARGETS ?? "2000", 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
};

/** Soft warn threshold surfaced in the create drawer. */
export const GHOST_WARN_TARGETS = 500;
