"use client";

import { useMemo } from "react";
import { Repeat, Play, Users } from "lucide-react";

import { parsePhoneList } from "@/lib/campaignV2Shared";
import { TIMEZONE_OPTIONS, type WizardState } from "../wizardState";

interface Props {
  state: WizardState;
}

export default function PreviewRail({ state }: Props) {
  const parsedCount = useMemo(
    () => parsePhoneList(state.numbersText).length,
    [state.numbersText],
  );

  const tzLabel =
    TIMEZONE_OPTIONS.find((o) => o.value === state.timezone)?.label ?? state.timezone;

  const modeLabel = state.campaignType === "recurring" ? "Repeat" : "Fixed";
  const ModeIcon = state.campaignType === "recurring" ? Repeat : Play;

  const nextStepLabel = state.step < 5 ? `Step ${state.step + 1}` : "Launch";
  const nextStepDesc =
    state.step < 5
      ? "Continue when this step's required fields are filled."
      : "Launch the campaign when you're ready.";

  return (
    <aside className="border-l border-[var(--border)] bg-[var(--bg-sidebar)] overflow-y-auto py-8 px-6 flex flex-col gap-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]">
        Live preview
      </p>

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-[18px]">
        <div className="text-base font-semibold leading-tight">
          {state.name || (
            <span className="italic text-[var(--text-3)] font-normal text-sm">Untitled campaign</span>
          )}
        </div>
        <div className="text-[11px] text-[var(--text-3)] font-mono mt-1">{tzLabel}</div>

        {state.segmentName && (
          <div className="text-[11px] text-[var(--text-2)] mt-2 inline-flex items-center gap-1.5">
            <Users size={11} className="text-[var(--text-3)]" />
            <span className="truncate">{state.segmentName}</span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3.5 my-4 py-3.5 border-t border-b border-[var(--border)]">
          <div>
            <div className="text-[20px] font-bold tabular-nums leading-none text-blue-400">
              {parsedCount > 0 ? parsedCount.toLocaleString() : "—"}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold mt-1">
              Numbers
            </div>
          </div>
          <div>
            <div className="text-[20px] font-bold tabular-nums leading-none text-emerald-400 inline-flex items-center gap-1.5">
              <ModeIcon size={14} />
              <span>{modeLabel}</span>
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold mt-1">
              Mode
            </div>
          </div>
        </div>

        <div className="text-[12px] text-[var(--text-3)] leading-snug">
          {state.step === 1
            ? "Pick a segment or paste numbers to start."
            : "Fill in the remaining steps to refine the preview."}
        </div>
      </section>

      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-[18px]">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold">
          Next up
        </div>
        <div className="text-sm font-semibold mt-1">{nextStepLabel}</div>
        <div className="text-[12px] text-[var(--text-3)] mt-1 leading-snug">{nextStepDesc}</div>
      </section>
    </aside>
  );
}
