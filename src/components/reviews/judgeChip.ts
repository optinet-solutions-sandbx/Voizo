// src/components/reviews/judgeChip.ts
// PURE mapping for the AI judge verdict chip — no React, unit-testable.

export interface ChipStyle {
  label: string;
  classes: string;
}

export function judgeChipStyle(verdict: string | null | undefined): ChipStyle {
  switch (verdict) {
    case "success":
      return { label: "success", classes: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
    case "failure":
      return { label: "failure", classes: "bg-red-500/15 text-red-400 border-red-500/30" };
    case "unsure":
      return { label: "unsure", classes: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
    default:
      return { label: "not graded", classes: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]" };
  }
}

/** "87%" for a 0..1 fraction (clamped); "" for null/NaN. */
export function formatConfidence(confidence: number | null | undefined): string {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return "";
  return `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}
