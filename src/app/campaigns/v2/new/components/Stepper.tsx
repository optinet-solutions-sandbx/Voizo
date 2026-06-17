"use client";

import { Check } from "lucide-react";
import type { Step } from "../wizardState";
import { STEPS } from "../wizardState";

interface Props {
  currentStep: Step;
  onJump: (step: Step) => void;
}

export default function Stepper({ currentStep, onJump }: Props) {
  return (
    <aside className="border-r border-[var(--border)] overflow-y-auto py-8 pl-6 pr-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-3)] mb-5">
        Create campaign
      </p>
      <div className="glow-card flex flex-col rounded-2xl p-4">
        {STEPS.map((s, i) => {
          const isDone = s.step < currentStep;
          const isActive = s.step === currentStep;
          const isLast = i === STEPS.length - 1;
          return (
            <button
              key={s.step}
              type="button"
              onClick={() => onJump(s.step)}
              className="group grid grid-cols-[32px_1fr] gap-3.5 py-2 text-left items-start relative"
            >
              <div
                className={`relative w-7 h-7 rounded-full grid place-items-center text-xs font-semibold font-mono border-[1.5px] z-[2] transition-all ${
                  isActive
                    ? "bg-blue-500 border-blue-500 text-white shadow-[0_0_0_4px_rgba(79,141,248,0.25)]"
                    : isDone
                      ? "bg-emerald-500 border-emerald-500 text-white"
                      : "bg-[var(--bg-card)] border-[var(--border-2)] text-[var(--text-3)] group-hover:border-[var(--border-2)] group-hover:text-[var(--text-2)]"
                }`}
              >
                {isDone ? <Check size={13} strokeWidth={3} /> : s.step}
              </div>
              <div className="pt-0.5">
                <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--text-3)]">
                  {s.label}
                </div>
                <div
                  className={`text-sm mt-0.5 transition-colors ${
                    isActive
                      ? "text-[var(--text-1)] font-semibold"
                      : isDone
                        ? "text-[var(--text-2)] font-medium"
                        : "text-[var(--text-2)] font-medium group-hover:text-[var(--text-1)]"
                  }`}
                >
                  {s.name}
                </div>
                <div className="text-[11px] mt-1 leading-snug text-[var(--text-3)]">
                  {s.defaultSummary}
                </div>
              </div>
              {!isLast && (
                <span
                  aria-hidden
                  className={`absolute left-[13.5px] top-[36px] bottom-[-10px] w-[1.5px] z-[1] ${
                    isDone ? "bg-emerald-500" : "bg-[var(--border-2)]"
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
