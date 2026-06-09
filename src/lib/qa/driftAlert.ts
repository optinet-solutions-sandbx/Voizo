// src/lib/qa/driftAlert.ts
// PURE drift detection for the golden-set calibration log — NO I/O, no env, so it
// unit-tests without secrets (mirrors qaScoreMath.ts / goldenSetMath.ts). The cron
// (api/cron/golden-replay) does the IO (listRuns + postSlackAlert) and feeds these.
import type { RunSummary } from "./goldenSetData";

export interface DriftReading {
  kappa: number | null;
  n: number;
}
export interface DriftDecision {
  alert: boolean;
  reason: string;
}

/**
 * PURE: most-recent run for a judge_version from a newest-first run list (listRuns
 * orders created_at desc). null when that judge_version has no prior run. Used to
 * capture the PRIOR reading BEFORE a fresh replay is written, so the crossing check
 * compares against the previous run, not against itself.
 */
export function selectPriorRun(runs: RunSummary[], judgeVersion: string): RunSummary | null {
  for (const r of runs) if (r.judgeVersion === judgeVersion) return r;
  return null;
}

/**
 * PURE: should a calibration-drift alert fire?
 *  - kappa null → no (only the manual-replay path can pass null; a fresh cron run
 *    always has a numeric kappa from computeCalibration).
 *  - n below floor → no (too few items to trust — and this IS the real guard for a
 *    degraded cron run, where computeCalibration yields n=0 + kappa=0, not null).
 *  - kappa >= threshold → no (healthy).
 *  - kappa < threshold → alert ONLY on a downward CROSSING: the prior run of this
 *    judge_version was healthy, OR there is no prior (a brand-new judge that lands
 *    below the bar). A SUSTAINED-low judge_version does NOT re-alert (prior also low)
 *    — stateless dedup, no schema/state row needed.
 */
export function shouldAlertDrift(opts: {
  latest: DriftReading;
  prior: DriftReading | null;
  threshold: number;
  minN: number;
}): DriftDecision {
  const { latest, prior, threshold, minN } = opts;
  if (latest.kappa == null) return { alert: false, reason: "no kappa (n=0 or all undecided)" };
  if (latest.n < minN) return { alert: false, reason: `n=${latest.n} below floor ${minN}` };
  if (latest.kappa >= threshold) return { alert: false, reason: `kappa ${latest.kappa} >= ${threshold} (healthy)` };
  if (prior == null || prior.kappa == null)
    return { alert: true, reason: `kappa ${latest.kappa} < ${threshold} (new judge_version, no healthy prior)` };
  if (prior.kappa >= threshold)
    return { alert: true, reason: `kappa crossed ${threshold}: prior ${prior.kappa} -> ${latest.kappa}` };
  return { alert: false, reason: `kappa ${latest.kappa} still < ${threshold} but prior already low (deduped)` };
}
