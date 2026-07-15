"use client";

import { useMemo } from "react";
import { Lightbulb, Repeat, Play, Users, Zap } from "lucide-react";

import { parsePhoneList } from "@/lib/campaignV2Shared";
import { TIMEZONE_OPTIONS, type WizardState } from "../wizardState";
import { useMagnetic } from "@/components/useMagnetic";

interface Props {
  state: WizardState;
}

/** Step- and mode-aware tips — the rail doubles as the user manual. */
function tipsFor(state: WizardState): string[] {
  switch (state.step) {
    case 1:
      return [
        "Repeat daily and Real-time campaigns need exactly one segment. Click a segment row, not the checkboxes.",
        "Test campaigns stay out of audience suggestions.",
      ];
    case 2:
      return state.agentMode === "script"
        ? [
            "The script is locked in at launch. Changing it later means a new campaign.",
            "The script decides WHAT gets said; the persona sets WHO is saying it.",
          ]
        : [
            "Prompt edits apply only to this campaign's own copy of the agent.",
            "The agent's voice comes from the base agent you pick.",
          ];
    case 3: {
      const tips: string[] = ["All times are the customer's local time."];
      if (state.campaignType === "recurring") {
        tips.push(
          "Further notice: runs until you press Stop.",
          "A specific date: the last day it runs.",
          "N occurrences: stops after running N days. Empty-list days don't count.",
        );
      }
      if (state.realtime) {
        tips.push("Daily cap is the spending brake. Sign-ups past the cap wait for tomorrow.");
        tips.push("Call delay counts from when a sign-up first appears in your segment. Sign-ups outside calling hours are called next morning.");
      }
      if (state.campaignType === "fixed") {
        tips.push("A retry gap longer than the day's window means one attempt per day.");
      }
      return tips;
    }
    case 4:
      return [
        "One text per player per campaign, never more.",
        state.smsConsentMode === "registered_optin"
          ? "Last resort on: a voicemail gets a call back, and the text goes out only after the last failed try."
          : "The agent must hear a clear yes on the call before any text goes out.",
        "“Don’t text me” and the Do-Not-Call list always win.",
      ];
    default:
      return [
        "What you launch is what runs. Check the numbers, mode, and texts one last time.",
        "You can pause any campaign from the Campaigns page. Repeating ones also get a Stop that ends today and tomorrow.",
      ];
  }
}

export default function PreviewRail({ state }: Props) {
  const parsedCount = useMemo(
    () => parsePhoneList(state.numbersText).length,
    [state.numbersText],
  );

  const tzLabel =
    TIMEZONE_OPTIONS.find((o) => o.value === state.timezone)?.label ?? state.timezone;

  const isRealtime = state.campaignType === "recurring" && state.realtime;
  const modeLabel =
    state.campaignType === "recurring" ? (isRealtime ? "Real-time" : "Repeat") : "Fixed";
  const ModeIcon = isRealtime ? Zap : state.campaignType === "recurring" ? Repeat : Play;

  const nextStepLabel = state.step < 5 ? `Step ${state.step + 1}` : "Launch";
  const nextStepDesc =
    state.step < 5
      ? "Continue when this step's required fields are filled."
      : "Launch the campaign when you're ready.";

  const card1Ref = useMagnetic<HTMLDivElement>();
  const card2Ref = useMagnetic<HTMLDivElement>();

  return (
    <aside className="border-l border-[var(--border)] bg-[var(--bg-sidebar)] overflow-y-auto py-8 px-6 flex flex-col gap-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-3)]">
        Live preview
      </p>

      <div ref={card1Ref} className="glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-[18px]">
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
      </div>

      <div ref={card2Ref} className="glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-[18px]">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold">
          Next up
        </div>
        <div className="text-sm font-semibold mt-1">{nextStepLabel}</div>
        <div className="text-[12px] text-[var(--text-3)] mt-1 leading-snug">{nextStepDesc}</div>
      </div>

      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-[18px]">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold inline-flex items-center gap-1.5">
          <Lightbulb size={11} className="text-amber-400" /> Tips
        </div>
        <ul className="mt-2 flex flex-col gap-2">
          {tipsFor(state).map((tip) => (
            <li key={tip} className="text-[12px] text-[var(--text-3)] leading-snug pl-3 relative">
              <span className="absolute left-0 top-[7px] w-1 h-1 rounded-full bg-[var(--text-3)] opacity-60" />
              {tip}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
