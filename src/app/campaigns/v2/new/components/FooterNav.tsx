"use client";

import { ChevronLeft, ChevronRight, Loader2, Rocket } from "lucide-react";
import type { Step } from "../wizardState";
import { useMagnetic } from "@/components/useMagnetic";

interface Props {
  currentStep: Step;
  onBack: () => void;
  onNext: () => void;
  onLaunch?: () => void;
  nextDisabled?: boolean;
  /** While true, the Launch button shows a spinner instead of the rocket. */
  saving?: boolean;
}

export default function FooterNav({
  currentStep, onBack, onNext, onLaunch, nextDisabled, saving,
}: Props) {
  const isLast = currentStep === 5;
  const primaryRef = useMagnetic<HTMLButtonElement>();
  return (
    <div className="flex items-center justify-between gap-3 pt-5 mt-7 border-t border-[var(--border)]">
      {currentStep > 1 ? (
        <button
          type="button"
          onClick={onBack}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[var(--border)] text-[var(--text-2)] text-sm font-medium hover:text-[var(--text-1)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <ChevronLeft size={14} /> Back
        </button>
      ) : (
        <span />
      )}

      {isLast ? (
        <button
          ref={primaryRef}
          type="button"
          onClick={onLaunch}
          disabled={nextDisabled}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold shadow-md shadow-emerald-500/25 transition hover:bg-emerald-400 hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
        >
          {saving ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Launching…
            </>
          ) : (
            <>
              <Rocket size={14} /> Launch campaign
            </>
          )}
        </button>
      ) : (
        <button
          ref={primaryRef}
          type="button"
          onClick={onNext}
          disabled={nextDisabled}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-semibold shadow-md shadow-blue-500/25 transition hover:bg-blue-400 hover:-translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
        >
          Continue <ChevronRight size={14} />
        </button>
      )}
    </div>
  );
}
