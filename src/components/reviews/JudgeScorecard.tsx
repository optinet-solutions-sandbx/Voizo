"use client";
import { Scale } from "lucide-react";

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
        <Scale size={14} className="text-blue-400" />
        <span className="text-[13px] font-semibold">Auto-review — agreement with your ratings</span>
        <div className="ml-auto flex items-center gap-2">
          {judgeEnabled && onGradeAll && (
            <button
              type="button"
              onClick={onGradeAll}
              disabled={gradingAll}
              title="Score every unscored real conversation in this campaign (voicemails + short calls are skipped)"
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-lg border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-1)] transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Scale size={11} /> {gradingAll ? "scoring…" : "Score all"}
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
          Auto-review is off. Set <span className="font-mono">QA_JUDGE_ENABLED=true</span> + your provider API key to
          enable, then score calls to see how it agrees with your ratings.
        </p>
      ) : !calibration || calibration.n === 0 ? (
        <p className="text-[11px] text-[var(--text-3)]">
          On · {scoredCount} call{scoredCount === 1 ? "" : "s"} scored. No overlap with your ratings yet — rate + score
          the same calls to populate the gauge.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <ScStat label="Agree with you" value={`${Math.round(calibration.agreement * 100)}%`} tone="text-emerald-400" />
          <ScStat label="Reliability (κ)" value={calibration.cohens_kappa.toFixed(2)} tone="text-[var(--text-1)]" />
          <ScStat label="Compared" value={`n=${calibration.n}`} tone="text-[var(--text-3)]" />
          <ScStat label="Scored" value={scoredCount} tone="text-blue-400" />
          <p className="text-[11px] text-[var(--text-3)] basis-full">
            Agreement = the auto-review&apos;s success/failure matches your good/bad on the same call (unsure excluded). κ
            corrects for chance.
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
