"use client";

import { Bot, FileText, Loader2, Megaphone } from "lucide-react";
import type { Dispatch } from "react";

import type { WizardAction, WizardState } from "../wizardState";
import { VOICE_OPTIONS } from "@/lib/voiceOptions";
import StyledSelect from "@/components/StyledSelect";
import { DEFAULT_SHORT_PROMPT } from "@/lib/scriptEngine/lab-tools";

/** Shape of an entry in GET /api/vapi/assistants — same as classic page-classic.tsx:111-118. */
export interface Assistant {
  id: string;
  name: string;
  voiceId: string | null;
  voiceProvider: string | null;
  systemPrompt: string | null;
  firstMessage: string | null;
}

/** Shape of an entry in GET /api/scripts (VOZ-159; persona added VOZ-188). */
export interface ScriptOption {
  id: string;
  name: string;
  description: string;
  /** The script's own persona — previewed read-only below the picker.
   *  May be absent from older deploys; treat missing as "". */
  persona?: string;
}

interface Props {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  assistants: Assistant[] | null;
  assistantsError: string | null;
  scripts: ScriptOption[] | null;
  scriptsError: string | null;
}

export default function StepAgent({ state, dispatch, assistants, assistantsError, scripts, scriptsError }: Props) {
  const selected = assistants?.find((a) => a.id === state.vapiAssistantId) ?? null;
  const isScript = state.agentMode === "script";

  /**
   * Atomic pick: when an assistant is selected, set vapiAssistantId +
   * baseVoiceId + systemPrompt in one dispatch. R3: never touch voiceId.
   * Mirrors classic page-classic.tsx:278-296.
   */
  function pickAssistant(a: Assistant) {
    dispatch({
      type: "SET_AGENT_FIELDS",
      payload: {
        vapiAssistantId: a.id,
        vapiAssistantName: a.name,
        baseVoiceId: a.voiceId,
        systemPrompt: a.systemPrompt ?? "",
      },
    });
  }

  return (
    <div className="flex-1 flex flex-col">
      <h1 className="text-[22px] font-bold tracking-tight">Who&apos;s making the call?</h1>
      <p className="text-sm text-[var(--text-3)] mt-1.5 leading-relaxed">
        {isScript
          ? "Pick a Script you built in the Script Builder. A Script is the step by step plan for the call. When you launch, the calling agent is built from it."
          : "Pick the agent that runs the call, then tweak its instructions for this campaign. Its voice stays fixed to the agent's default."}
      </p>

      {/* VOZ-159: Agent vs Script mode selector */}
      <div className="mt-6 grid grid-cols-2 gap-2.5">
        {([
          { mode: "assistant" as const, icon: Bot, label: "Agent", sub: "Runs from written instructions" },
          { mode: "script" as const, icon: FileText, label: "Script", sub: "Runs from a step by step flow you built" },
        ]).map(({ mode, icon: Icon, label, sub }) => {
          const active = state.agentMode === mode;
          return (
            <button
              key={mode}
              type="button"
              onClick={() => dispatch({ type: "SET_AGENT_FIELDS", payload: { agentMode: mode } })}
              className={`text-left flex items-start gap-3 px-3.5 py-3 rounded-xl border-[1.5px] transition-all ${
                active ? "border-blue-500 bg-blue-500/[0.08]" : "border-[var(--border)] bg-[var(--bg-app)] hover:border-blue-500/40"
              }`}
            >
              <div className={`w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 ${active ? "bg-blue-500 text-white" : "bg-[var(--bg-elevated)] text-[var(--text-3)]"}`}>
                <Icon size={15} />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--text-1)]">{label}</div>
                <div className="text-[12px] text-[var(--text-3)] mt-0.5">{sub}</div>
              </div>
            </button>
          );
        })}
      </div>

      {isScript ? (
        <div className="mt-7 flex flex-col gap-[18px]">
          {/* Script picker */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-[var(--text-2)]">
              Script <span className="text-red-400">*</span>
            </label>
            {scriptsError ? (
              <div className="px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">{scriptsError}</div>
            ) : scripts === null ? (
              <div className="px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-sm text-[var(--text-3)] inline-flex items-center gap-2">
                <Loader2 size={14} className="animate-spin" />
                Loading scripts…
              </div>
            ) : scripts.length === 0 ? (
              <div className="px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-sm text-[var(--text-3)]">
                No scripts yet. Build one in the Script Builder first.
              </div>
            ) : (
              <StyledSelect
                icon={<FileText size={14} />}
                value={state.scriptId}
                onChange={(value) => {
                  const s = scripts.find((x) => x.id === value);
                  // VOZ-188: the script's persona rides along (snapshot at
                  // launch) — the preview below shows exactly what launches.
                  dispatch({
                    type: "SET_AGENT_FIELDS",
                    payload: { scriptId: s?.id ?? "", scriptName: s?.name ?? "", persona: s?.persona ?? "" },
                  });
                }}
                options={scripts.map((s) => ({ value: s.id, label: s.name }))}
                placeholder="Select a script…"
              />
            )}
            <a href="/script-builder" target="_blank" rel="noreferrer" className="text-[12px] text-blue-400 hover:text-blue-300 w-fit">
              Edit in Script Builder →
            </a>
          </div>

          {/* Voice (VOZ-168-lite, optional; relabeled from "Base agent" VOZ-188):
              which agent the script clone is composed FROM. Supplies the VOICE +
              call setup only — the script still decides everything that's said.
              Empty = the standard script base (VAPI_SCRIPT_BASE_ASSISTANT_ID),
              byte-identical to before. */}
          {assistants !== null && !assistantsError && assistants.length > 0 && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-[var(--text-2)] flex items-baseline gap-1.5">
                Voice
                <span className="text-[11px] text-[var(--text-3)] font-normal">optional</span>
              </label>
              <StyledSelect
                icon={<Bot size={14} />}
                value={state.vapiAssistantId}
                onChange={(value) => {
                  const a = assistants.find((x) => x.id === value);
                  dispatch({
                    type: "SET_AGENT_FIELDS",
                    payload: { vapiAssistantId: a?.id ?? "", vapiAssistantName: a?.name ?? "", baseVoiceId: a?.voiceId ?? null },
                  });
                }}
                options={[
                  { value: "", label: "Default voice" },
                  ...assistants.map((a) => ({ value: a.id, label: a.name })),
                ]}
              />
              {selected ? (
                <div className="flex items-center gap-2 text-[13px] text-[var(--text-3)]">
                  <Megaphone size={13} />
                  <span>
                    Voice:{" "}
                    <span className="text-[var(--text-2)]">
                      {VOICE_OPTIONS.find((v) => v.id === state.baseVoiceId)?.name ??
                        (state.baseVoiceId ? "Custom voice" : "agent default")}
                    </span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-[var(--text-3)] bg-[var(--bg-app)] px-1.5 py-0.5 rounded font-medium">
                    locked
                  </span>
                </div>
              ) : (
                <p className="text-[11px] text-[var(--text-3)]">
                  The Script decides what gets said. This only changes the voice.
                </p>
              )}
            </div>
          )}

          {/* Persona — read-only preview of the script's persona (VOZ-188).
              It's edited in the Script Builder and snapshotted into the
              campaign at launch, so what the ▶ test call spoke is what runs. */}
          {state.scriptId && (
            <div className="flex flex-col gap-2">
              <label className="text-xs font-medium text-[var(--text-2)] flex items-baseline gap-1.5">
                Persona
                <span className="text-[11px] text-[var(--text-3)] font-normal">from the script</span>
              </label>
              <div className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm leading-relaxed whitespace-pre-wrap max-h-44 overflow-y-auto">
                {state.persona ? (
                  <span className="text-[var(--text-2)]">{state.persona}</span>
                ) : (
                  <span className="text-[var(--text-3)]">{DEFAULT_SHORT_PROMPT}</span>
                )}
              </div>
              <p className="text-[11px] text-[var(--text-3)]">
                {state.persona
                  ? "Who the agent says it is — set on the script, so what you tested is what launches here."
                  : "This script has no persona saved yet, so it will launch with the default shown above."}
              </p>
              <a
                href={`/script-builder?id=${state.scriptId}`}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] text-blue-400 hover:text-blue-300 w-fit"
              >
                Edit persona in Script Builder →
              </a>
            </div>
          )}
        </div>
      ) : (
      <div className="mt-7 flex flex-col gap-[18px]">
        {/* Agent picker */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-[var(--text-2)]">
            Agent <span className="text-red-400">*</span>
          </label>

          {assistantsError ? (
            <div className="px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
              {assistantsError}
            </div>
          ) : assistants === null ? (
            <div className="px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-sm text-[var(--text-3)] inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              Loading agents…
            </div>
          ) : assistants.length === 0 ? (
            <div className="px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-sm text-[var(--text-3)]">
              No agents found. Create one in Vapi first.
            </div>
          ) : (
            <StyledSelect
              icon={<Bot size={14} />}
              value={state.vapiAssistantId}
              onChange={(value) => {
                const a = assistants.find((x) => x.id === value);
                if (a) pickAssistant(a);
              }}
              options={assistants.map((a) => ({ value: a.id, label: a.name }))}
              placeholder="Select an agent…"
            />
          )}
        </div>

        {/* Selected agent — one quiet locked-voice line */}
        {selected && (
          <div className="flex items-center gap-2 text-[13px] text-[var(--text-3)]">
            <Megaphone size={13} />
            <span>
              Voice:{" "}
              <span className="text-[var(--text-2)]">
                {(state.baseVoiceId && VOICE_OPTIONS.find((v) => v.id === state.baseVoiceId)?.name) || "agent default"}
              </span>
            </span>
            <span className="text-[10px] uppercase tracking-wide text-[var(--text-3)] bg-[var(--bg-app)] px-1.5 py-0.5 rounded font-medium">
              locked
            </span>
          </div>
        )}

        {/* System prompt textarea */}
        {selected && (
          <div className="flex flex-col gap-2">
            <label htmlFor="wizard-prompt" className="text-xs font-medium text-[var(--text-2)] flex items-baseline gap-1.5">
              System prompt
              <span className="text-[11px] text-[var(--text-3)] font-normal">tweak for this campaign only</span>
            </label>
            <textarea
              id="wizard-prompt"
              value={state.systemPrompt}
              onChange={(e) =>
                dispatch({ type: "SET_AGENT_FIELDS", payload: { systemPrompt: e.target.value } })
              }
              rows={8}
              className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y text-sm leading-relaxed"
              placeholder="Inherits from the selected agent…"
            />
            <p className="text-[11px] text-[var(--text-3)]">
              A dedicated copy of this agent is created for this campaign, so prompt edits
              don&apos;t affect other campaigns.
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
