// src/lib/qa/qaConfig.ts
// Env-gated config for the QA judge. EVERYTHING safe-by-default: the feature is
// OFF until QA_JUDGE_ENABLED=true AND ANTHROPIC_API_KEY is set (SPEC §7: no calls
// scored before Maria's PII sign-off). Pure module — no I/O, importable anywhere.

export const QA_JUDGE_ENABLED = process.env.QA_JUDGE_ENABLED === "true";
// Provider: "openai" (available now) or "anthropic" (preferred for independence —
// wired so the later swap is just QA_JUDGE_PROVIDER=anthropic + the key).
export const QA_JUDGE_PROVIDER = (process.env.QA_JUDGE_PROVIDER || "openai").toLowerCase();
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
// ⚠ Confirm the exact API model id your key accepts; override via QA_JUDGE_MODEL.
export const QA_JUDGE_MODEL =
  process.env.QA_JUDGE_MODEL || (QA_JUDGE_PROVIDER === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.5");

// Throughput / cost guardrails (SPEC "Cost & guardrails"). Parsed defensively:
// `Number(env ?? default)` would yield NaN/0 on a malformed env var (e.g.
// QA_CONCURRENCY="" -> 0 infinite-loops the cron's chunk stride; a NaN cap removes
// the scan bound). numEnv falls back to the safe default unless the value parses to
// a finite number >= min.
const numEnv = (v: string | undefined, d: number, min: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : d;
};
export const QA_ROW_CAP = numEnv(process.env.QA_ROW_CAP, 50, 1); // rows/tick
export const QA_CONCURRENCY = Math.floor(numEnv(process.env.QA_CONCURRENCY, 4, 1)); // parallel judge calls (>=1)
export const QA_MAX_SCORES_PER_DAY = numEnv(process.env.QA_MAX_SCORES_PER_DAY, 500, 1);
export const QA_MIN_DURATION_SECONDS = numEnv(process.env.QA_MIN_DURATION_SECONDS, 30, 0); // 0 disables the gate
// (QA_SAMPLE_PCT intentionally omitted: a candidate-sampling lever isn't needed at
// current volume — ROW_CAP + the daily cap bound cost. Re-add a real sampler when
// volume grows, rather than ship an inert knob that reads as a live control.)

// Per-call ceilings.
export const QA_MAX_OUTPUT_TOKENS = 512; // verdict JSON is ~150-250 tok; ceiling only
export const QA_TRANSCRIPT_CHAR_CAP = 6000; // bound a pathological long call before send

/** True only when the judge can actually run (flag ON + the active provider's key present). */
export function qaJudgeReady(): boolean {
  if (!QA_JUDGE_ENABLED) return false;
  return QA_JUDGE_PROVIDER === "anthropic" ? ANTHROPIC_API_KEY.length > 0 : OPENAI_API_KEY.length > 0;
}
