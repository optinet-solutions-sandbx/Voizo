// src/lib/qa/goldenSetMath.ts
// PURE golden-eval-set math — NO I/O, no env, no Supabase, so it unit-tests without
// secrets (mirrors qaScoreMath.ts, kept separate from goldenSetData.ts which imports
// the service-role client). Reuses computeCalibration's row shape so a golden replay
// feeds the EXISTING calibration math unchanged.
import type { CalibrationRow } from "./qaScoreMath";

/** Human label -> the binary success axis (matches the qa_calibration view's mapping). */
export function humanSuccess(verdict: "good" | "bad"): "success" | "failure" {
  return verdict === "good" ? "success" : "failure";
}

export interface GoldenItemLite {
  id: string;
  callId: string | null; // null for synthetic items
  humanVerdict: "good" | "bad";
}

/** The judge's per-item outcome; null = the judge skipped or errored on that item. */
export type JudgeOutcome = "success" | "failure" | "unsure" | null;

/**
 * PURE: build computeCalibration rows from frozen items + per-item judge outcomes.
 * call_id := callId ?? id — synthetic items have a null callId but a unique id, and
 * computeCalibration dedups by call_id, so the id keeps them distinct. A missing key
 * in `judgeByItem` (skip/error) carries through as a null judge verdict, which
 * computeCalibration then excludes from kappa.
 */
export function toCalibrationRows(
  items: GoldenItemLite[],
  judgeByItem: Map<string, JudgeOutcome>,
): CalibrationRow[] {
  return items.map((it) => ({
    call_id: it.callId ?? it.id,
    success_verdict: judgeByItem.get(it.id) ?? null,
    human_success: humanSuccess(it.humanVerdict),
  }));
}

export interface RawLabel {
  callId: string;
  verdict: "good" | "bad";
  reason: string | null;
  labeledBy: string;
}
export interface DedupedLabel {
  callId: string;
  verdict: "good" | "bad";
  reason: string | null;
  labeledBy: string; // the single reviewer, or "majority M/N" when multiple labeled the call
  labelerCount: number;
}

/**
 * PURE: collapse multiple reviewers' labels for the same call to ONE verdict by
 * MAJORITY (good vs bad) — the same dedup principle computeCalibration applies on the
 * calibration side. A TIE drops the call (no trusted verdict ⇒ not a clean ruler entry).
 * Single-reviewer calls (today's reality) pass through unchanged. Prevents the freeze
 * from emitting two items with the same call_id (which unique(set_id,call_id) rejects).
 */
export function dedupeLabelsByCall(labels: RawLabel[]): DedupedLabel[] {
  const by = new Map<string, RawLabel[]>();
  for (const l of labels) {
    const arr = by.get(l.callId);
    if (arr) arr.push(l);
    else by.set(l.callId, [l]);
  }
  const out: DedupedLabel[] = [];
  for (const [callId, rows] of by) {
    let good = 0;
    let bad = 0;
    for (const r of rows) {
      if (r.verdict === "good") good++;
      else bad++;
    }
    if (good === bad) continue; // tie → drop (ambiguous; matches computeCalibration's tie-drop)
    const verdict: "good" | "bad" = good > bad ? "good" : "bad";
    const rep = rows.find((r) => r.verdict === verdict) ?? rows[0]; // representative for reason/provenance
    out.push({
      callId,
      verdict,
      reason: rep.reason,
      labeledBy: rows.length > 1 ? `majority ${Math.max(good, bad)}/${rows.length}` : rep.labeledBy,
      labelerCount: rows.length,
    });
  }
  return out;
}

export interface PromptScoreRow {
  prompt_version_id: string | null;
  prompt_version_match: string; // 'single' | 'time_window' | 'ambiguous' | 'unresolved'
  success_verdict: string | null; // 'success' | 'failure' | 'unsure' | null
}

export interface PromptVersionStat {
  promptVersionId: string;
  n: number; // decided calls (success + failure) — the success_rate denominator
  success: number;
  failure: number;
  unsure: number;
  successRate: number | null; // success / (success + failure); null when no decided calls
}

// Only rigorous attribution counts in a "v7 vs v6" comparison (SPEC §3 / Slice-3 §3).
const RIGOROUS_MATCHES = new Set(["single", "time_window"]);

/**
 * PURE: judge success-rate per prompt_version_id — the "v7 vs v6" readout. Rows whose
 * prompt_version_id is null, or whose match is ambiguous/unresolved, are dropped
 * (rigorous attribution only). `unsure` is tallied but excluded from the rate
 * denominator (you can't credit/blame a prompt for an abstention).
 */
export function computePromptVersionStats(rows: PromptScoreRow[]): PromptVersionStat[] {
  const by = new Map<string, { success: number; failure: number; unsure: number }>();
  for (const r of rows) {
    if (!r.prompt_version_id) continue;
    if (!RIGOROUS_MATCHES.has(r.prompt_version_match)) continue;
    let e = by.get(r.prompt_version_id);
    if (!e) {
      e = { success: 0, failure: 0, unsure: 0 };
      by.set(r.prompt_version_id, e);
    }
    if (r.success_verdict === "success") e.success++;
    else if (r.success_verdict === "failure") e.failure++;
    else if (r.success_verdict === "unsure") e.unsure++;
    // null / unknown verdicts are ignored
  }
  return [...by.entries()].map(([promptVersionId, c]) => {
    const denom = c.success + c.failure;
    return {
      promptVersionId,
      n: denom,
      success: c.success,
      failure: c.failure,
      unsure: c.unsure,
      successRate: denom > 0 ? Number((c.success / denom).toFixed(4)) : null,
    };
  });
}
