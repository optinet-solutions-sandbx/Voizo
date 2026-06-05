"use client";
import { Sparkles } from "lucide-react";
import { judgeChipStyle, formatConfidence } from "./judgeChip";

export interface JudgeScore {
  verdict: string | null;
  confidence: number | null;
  path: string | null;
  rationale: string | null;
}

export function JudgeVerdictChip({
  score,
  judgeEnabled,
  grading,
  onGrade,
}: {
  score: JudgeScore | null;
  judgeEnabled: boolean;
  grading: boolean;
  onGrade: () => void;
}) {
  if (score) {
    const style = judgeChipStyle(score.verdict);
    const conf = formatConfidence(score.confidence);
    return (
      <span
        className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${style.classes}`}
        title={score.rationale || "AI judge verdict"}
      >
        <Sparkles size={9} /> AI: {style.label}
        {conf ? ` ${conf}` : ""}
      </span>
    );
  }
  return (
    <button
      onClick={onGrade}
      disabled={!judgeEnabled || grading}
      title={
        judgeEnabled
          ? "Score this call with the AI judge"
          : "AI judge is OFF — set QA_JUDGE_ENABLED + ANTHROPIC_API_KEY to enable"
      }
      className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text-1)] hover:border-[var(--border-2)] transition disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Sparkles size={9} /> {grading ? "grading…" : judgeEnabled ? "Grade with AI" : "AI: not graded"}
    </button>
  );
}
