// Wall-clock budget guard for recurring child-spawn (audit 2026-05-29 F11).
//
// The campaign-scheduler cron GET shares one `maxDuration` budget across the
// sweeper, resume-fire, draft-fire, and the recurring child-spawn branch (which
// runs LAST). A single spawn does a synchronous segment fetch + Vapi clone +
// SIP lease + phone PATCH + two INSERTs + linkSlot. If the function is killed
// (hard `maxDuration` timeout) mid-spawn, it orphans a billable clone + a leased
// slot with no child row. The guard below makes the scheduler DEFER a spawn to
// the next tick when too little wall-clock remains to finish one safely — so a
// spawn is never *started* unless it can complete.

/** Conservative worst-case wall-clock for one recurring spawn. Tune in staging. */
export const RECURRING_SPAWN_BUDGET_MS = 30_000;

/** Cushion below the function's hard maxDuration kill. */
export const SPAWN_SAFETY_MS = 5_000;

/**
 * True when too little wall-clock remains in this cron tick to safely START
 * another recurring spawn without risking a mid-spawn timeout kill. When true,
 * the caller should defer the spawn to the next tick (no orphaned clone/slot).
 *
 * @param elapsedMs      ms elapsed since the cron handler started this tick
 * @param maxDurationSec the handler's `maxDuration` (seconds)
 */
export function recurringBudgetExhausted(
  elapsedMs: number,
  maxDurationSec: number,
  budgetMs: number = RECURRING_SPAWN_BUDGET_MS,
  safetyMs: number = SPAWN_SAFETY_MS,
): boolean {
  return elapsedMs > maxDurationSec * 1000 - budgetMs - safetyMs;
}
