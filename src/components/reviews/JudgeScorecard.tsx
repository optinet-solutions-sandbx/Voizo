"use client";
import { Sparkles } from "lucide-react";

export interface JudgeCalibration {
  n: number;
  agreement: number;
  cohens_kappa: number;
  matrix: { tp: number; tn: number; fp: number; fn: number };
}

export function JudgeScorecard({
  judgeEnabled,
  calibration,
  scoredCount,
  loading,
  onGradeAll,
  gradingAll,
  gradeMsg,
}: {
  judgeEnabled: boolean;
  calibration: JudgeCalibration | null;
  scoredCount: number;
  loading: boolean;
  onGradeAll?: () => void;
  gradingAll?: boolean;
  gradeMsg?: string | null;
}) {
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={14} className="text-violet-400" />
        <span className="text-[13px] font-semibold">AI Judge — calibration vs your labels</span>
        <div className="ml-auto flex items-center gap-2">
          {judgeEnabled && onGradeAll && (
            <button
              onClick={onGradeAll}
              disabled={gradingAll}
              title="Score every ungraded real conversation in this campaign (voicemails + short calls are skipped)"
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-lg border border-violet-500/40 text-violet-300 hover:bg-violet-500/10 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles size={11} /> {gradingAll ? "grading…" : "Grade all"}
            </button>
          )}
          <span
            className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border ${
              judgeEnabled
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]"
            }`}
          >
            {judgeEnabled ? "ON" : "OFF"}
          </span>
        </div>
      </div>
      {gradeMsg && <p className="text-[11px] text-[var(--text-3)] mb-2">{gradeMsg}</p>}
      {loading ? (
        <div className="h-5 w-2/3 rounded bg-[var(--bg-elevated)] animate-pulse" />
      ) : !judgeEnabled ? (
        <p className="text-[11px] text-[var(--text-3)]">
          The AI judge is off. Set <span className="font-mono">QA_JUDGE_ENABLED=true</span> +{" "}
          <span className="font-mono">ANTHROPIC_API_KEY</span> to enable, then grade calls to see how the judge agrees
          with your team.
        </p>
      ) : !calibration || calibration.n === 0 ? (
        <p className="text-[11px] text-[var(--text-3)]">
          On · {scoredCount} call{scoredCount === 1 ? "" : "s"} graded. No overlap with your labels yet — label + grade
          the same calls to populate the trust gauge.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <ScStat label="Agree with you" value={`${Math.round(calibration.agreement * 100)}%`} tone="text-emerald-400" />
          <ScStat label="Reliability (κ)" value={calibration.cohens_kappa.toFixed(2)} tone="text-[var(--text-1)]" />
          <ScStat label="Compared" value={`n=${calibration.n}`} tone="text-[var(--text-3)]" />
          <ScStat label="Graded" value={scoredCount} tone="text-violet-400" />
          <p className="text-[11px] text-[var(--text-3)] basis-full">
            Agreement = judge success/failure matches your good/bad on the same call (unsure excluded). κ corrects for
            chance.
          </p>
        </div>
      )}
    </section>
  );
}

function ScStat({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-lg font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[11px] text-[var(--text-3)] uppercase tracking-wider">{label}</span>
    </div>
  );
}
