// src/lib/qa/qaScoreMath.ts
// PURE attribution + calibration math for the QA judge — NO I/O, no env, no Supabase,
// so these unit-test without secrets. Mirrors promptVersionExtract.ts (kept separate
// from promptVersionData.ts, which imports the service-role client).

export type PromptMatch = "single" | "time_window" | "ambiguous" | "unresolved";
export interface PromptAttribution {
  promptVersionId: string | null;
  match: PromptMatch;
}

/** PURE: pick the prompt_version live at the call's created_at. `versions` is the
 *  campaign's prompt_versions (any order); we sort here. */
export function attributePromptVersion(
  callCreatedAt: string,
  versions: Array<{ id: string; created_at: string }>,
): PromptAttribution {
  if (!versions.length) return { promptVersionId: null, match: "unresolved" };
  const callMs = Date.parse(callCreatedAt);
  if (!Number.isFinite(callMs)) return { promptVersionId: null, match: "unresolved" };
  const parsed = versions.map((v) => ({ id: v.id, ms: Date.parse(v.created_at) }));
  const hasBadVersionDate = parsed.some((v) => !Number.isFinite(v.ms));
  const atOrBefore = parsed
    .filter((v) => Number.isFinite(v.ms) && v.ms <= callMs)
    .sort((a, b) => a.ms - b.ms);
  if (!atOrBefore.length) return { promptVersionId: null, match: "unresolved" };
  const latest = atOrBefore[atOrBefore.length - 1];
  const tiesAtLatest = atOrBefore.filter((v) => v.ms === latest.ms);
  if (tiesAtLatest.length > 1) return { promptVersionId: latest.id, match: "ambiguous" };
  // A sibling version with an unparseable timestamp means we can't be certain this
  // is the one that was live — report ambiguous rather than an over-confident single.
  if (hasBadVersionDate) return { promptVersionId: latest.id, match: "ambiguous" };
  return { promptVersionId: latest.id, match: atOrBefore.length === 1 ? "single" : "time_window" };
}

export interface CalibrationRow {
  call_id: string;
  success_verdict: string | null; // judge: 'success' | 'failure' | 'unsure' | null
  human_success: string | null; // human, mapped: 'success' | 'failure' | null
}
export interface CalibrationResult {
  n: number;
  agreement: number;
  cohens_kappa: number;
  matrix: { tp: number; tn: number; fp: number; fn: number };
}

/**
 * PURE: confusion matrix + %-agreement + Cohen's kappa on the binary success axis,
 * with ONE (judge, human) pair per call. The qa_calibration view emits one row per
 * (score, label); a call labeled by multiple reviewers yields multiple rows, so we
 * collapse the human side by MAJORITY here (good=success, bad=failure; unsure/null
 * excluded; a tie or all-unsure drops the call). The judge side is already one row
 * per call (filtered to a single judge_version upstream). Without this dedup a
 * multiply-labeled call would be over-counted in kappa.
 */
export function computeCalibration(rows: CalibrationRow[]): CalibrationResult {
  const byCall = new Map<string, { judge: string | null; success: number; failure: number }>();
  for (const r of rows) {
    let e = byCall.get(r.call_id);
    if (!e) {
      e = { judge: r.success_verdict, success: 0, failure: 0 };
      byCall.set(r.call_id, e);
    }
    if (e.judge == null) e.judge = r.success_verdict;
    if (r.human_success === "success") e.success++;
    else if (r.human_success === "failure") e.failure++;
  }
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (const e of byCall.values()) {
    if (e.judge !== "success" && e.judge !== "failure") continue; // judge unsure/null excluded
    if (e.success === e.failure) continue; // human tie / no decided human label excluded
    const hb = e.success > e.failure; // majority human verdict == success?
    const jb = e.judge === "success";
    if (jb && hb) tp++;
    else if (!jb && !hb) tn++;
    else if (jb && !hb) fp++;
    else fn++;
  }
  const n = tp + tn + fp + fn;
  const pObs = n ? (tp + tn) / n : 0;
  const pYes = n ? ((tp + fp) / n) * ((tp + fn) / n) : 0;
  const pNo = n ? ((fn + tn) / n) * ((fp + tn) / n) : 0;
  const pExp = pYes + pNo;
  const kappa = n && pExp < 1 ? (pObs - pExp) / (1 - pExp) : 0;
  return {
    n,
    agreement: Number(pObs.toFixed(4)),
    cohens_kappa: Number(kappa.toFixed(4)),
    matrix: { tp, tn, fp, fn },
  };
}
