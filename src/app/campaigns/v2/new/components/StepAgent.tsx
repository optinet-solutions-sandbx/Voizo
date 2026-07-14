"use client";

import { Bot, FileText, Loader2, Megaphone, Phone } from "lucide-react";
import type { Dispatch } from "react";

import type { WizardAction, WizardState } from "../wizardState";
import { VOICE_OPTIONS } from "@/lib/voiceOptions";

/** Shape of an entry in GET /api/vapi/assistants — same as classic page-classic.tsx:111-118. */
export interface Assistant {
  id: string;
  name: string;
  voiceId: string | null;
  voiceProvider: string | null;
  systemPrompt: string | null;
  firstMessage: string | null;
}

/** Shape of an entry in GET /api/scripts (VOZ-159). */
export interface ScriptOption {
  id: string;
  name: string;
  description: string;
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
          ? "Pick a Script — a call flow you built in the Script Builder. At launch a dedicated agent is composed from the script's boxes and answers."
          : "Pick the Vapi assistant. Voice is locked to the assistant's default. Change it in Vapi if you need a different one."}
      </p>

      {/* VOZ-159: Agent vs Script mode selector */}
      <div className="mt-6 grid grid-cols-2 gap-2.5">
        {([
          { mode: "assistant" as const, icon: Bot, label: "Vapi Agent", sub: "A prompt-driven assistant" },
          { mode: "script" as const, icon: FileText, label: "Script", sub: "A flow from the Script Builder" },
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
            <label htmlFor="wizard-script" className="text-xs font-medium text-[var(--text-2)]">
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
              <select
                id="wizard-script"
                value={state.scriptId}
                onChange={(e) => {
                  const s = scripts.find((x) => x.id === e.target.value);
                  dispatch({ type: "SET_AGENT_FIELDS", payload: { scriptId: s?.id ?? "", scriptName: s?.name ?? "" } });
                }}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 text-sm [color-scheme:dark]"
              >
                <option value="">Select a script…</option>
                {scripts.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <a href="/script-builder" target="_blank" rel="noreferrer" className="text-[12px] text-blue-400 hover:text-blue-300 w-fit">
              Edit in Script Builder →
            </a>
          </div>

          {/* Persona (who the agent is) — saved to system_prompt */}
          <div className="flex flex-col gap-2">
            <label htmlFor="wizard-persona" className="text-xs font-medium text-[var(--text-2)] flex items-center gap-1.5">
              Persona
              <span className="text-[11px] text-[var(--text-3)] font-normal">who the agent is — name, brand, tone</span>
            </label>
            <textarea
              id="wizard-persona"
              value={state.systemPrompt}
              onChange={(e) => dispatch({ type: "SET_AGENT_FIELDS", payload: { systemPrompt: e.target.value } })}
              rows={6}
              className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y text-sm leading-relaxed"
              placeholder="You are Tom — a warm, natural-sounding agent for Lucky Seven Casino…"
            />
            <p className="text-[11px] text-[var(--text-3)]">
              The script supplies WHAT to say and when; the persona sets WHO is saying it. Blank falls back to the engine default.
            </p>
          </div>
        </div>
      ) : (
      <div className="mt-7 flex flex-col gap-[18px]">
        {/* Assistant picker */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-medium text-[var(--text-2)]">
            Vapi assistant <span className="text-red-400">*</span>
          </label>

          {assistantsError ? (
            <div className="px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
              {assistantsError}
            </div>
          ) : assistants === null ? (
            <div className="px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-sm text-[var(--text-3)] inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              Loading assistants…
            </div>
          ) : assistants.length === 0 ? (
            <div className="px-4 py-3 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-sm text-[var(--text-3)]">
              No assistants found. Create one in Vapi first.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {assistants.map((a) => {
                const isActive = a.id === state.vapiAssistantId;
                const voiceName = a.voiceId
                  ? VOICE_OPTIONS.find((v) => v.id === a.voiceId)?.name ?? "Custom voice"
                  : "Assistant default";
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => pickAssistant(a)}
                    className={`text-left flex items-center gap-3 px-3.5 py-3 rounded-xl border-[1.5px] transition-all ${
                      isActive
                        ? "border-blue-500 bg-blue-500/[0.08]"
                        : "border-[var(--border)] bg-[var(--bg-app)] hover:border-blue-500/40"
                    }`}
                  >
                    <div
                      className={`w-9 h-9 rounded-lg grid place-items-center flex-shrink-0 transition-colors ${
                        isActive
                          ? "bg-blue-500 text-white"
                          : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
                      }`}
                    >
                      <Bot size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-[var(--text-1)] truncate">
                        {a.name}
                      </div>
                      <div className="text-[12px] text-[var(--text-3)] truncate mt-0.5">
                        Voice · {voiceName}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected-assistant detail strip (voice lock + prompt name) */}
        {selected && (
          <div className="px-4 py-3 rounded-xl bg-blue-500/[0.06] border border-blue-500/20">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Phone size={12} className="text-blue-400" />
                <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-3)]">
                  Prompt
                </span>
                <span className="text-[var(--text-1)] font-semibold">{selected.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Megaphone size={12} className="text-[var(--text-3)]" />
                <span className="text-[10px] uppercase tracking-wide font-semibold text-[var(--text-3)]">
                  Voice
                </span>
                <span className="text-[var(--text-1)] font-semibold">
                  {(state.baseVoiceId && VOICE_OPTIONS.find((v) => v.id === state.baseVoiceId)?.name) ||
                    "Assistant default"}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-[var(--text-3)] bg-[var(--bg-app)] px-1.5 py-0.5 rounded font-medium">
                  Locked
                </span>
              </div>
            </div>
            <p className="text-xs text-[var(--text-3)] mt-2">
              Voice is locked to the assistant&apos;s default to prevent performance drift. To
              change the voice, update the base assistant in Vapi.
            </p>
          </div>
        )}

        {/* System prompt textarea */}
        {selected && (
          <div className="flex flex-col gap-2">
            <label htmlFor="wizard-prompt" className="text-xs font-medium text-[var(--text-2)] flex items-center gap-1.5">
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
              placeholder="Inherits from selected assistant…"
            />
            <p className="text-[11px] text-[var(--text-3)]">
              A dedicated clone of this assistant will be provisioned for this campaign, so
              prompt edits don&apos;t affect other campaigns.
            </p>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
