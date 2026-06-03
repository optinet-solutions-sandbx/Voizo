"use client";

import { useMemo, type Dispatch } from "react";
import { Clock, Globe2, Info, Users } from "lucide-react";

import { parsePhoneList } from "@/lib/campaignV2Data";
import {
  allowedTimezonesForCountry,
  countryLabel,
  detectAudienceCountry,
} from "@/lib/audienceCountry";
import SegmentImporter from "@/components/SegmentImporter";
import VoizoSegmentImporter from "@/components/VoizoSegmentImporter";

import {
  getCallingHours,
  TIMEZONE_OPTIONS,
  type WizardAction,
  type WizardState,
} from "../wizardState";
import StyledSelect from "@/components/StyledSelect";

interface DuplicateSkipped {
  total: number;
  shown: number;
  appliedSkips: string[];
}

interface Props {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  /** Set by WizardPage when source=campaign prefill ran. Drives the
   *  "Duplicated from" banner's skip footnote. Null on non-duplicate flows. */
  duplicateSkipped?: DuplicateSkipped | null;
}

export default function StepAudience({ state, dispatch, duplicateSkipped }: Props) {
  const hours = getCallingHours(state.timezone);
  const tzLabel =
    TIMEZONE_OPTIONS.find((o) => o.value === state.timezone)?.label ?? state.timezone;
  const detectedPrefix = state.timezoneTouched ? "" : "Detected ";

  // Real-time E.164 validation — recomputed every keystroke to mirror the
  // classic form's live error feedback. No debounce on purpose.
  const parsedNumbers = useMemo(() => parsePhoneList(state.numbersText), [state.numbersText]);
  const hasContent = state.numbersText.trim().length > 0;
  const hasInvalidContent = hasContent && parsedNumbers.length === 0;

  // Country-aware TZ guardrail. Detection returns null when the sample is too
  // small (<5) or no prefix is ≥80% dominant. The dropdown always shows all
  // TIMEZONE_OPTIONS; the banner below surfaces the recommendation and any
  // mismatch. A mismatch is enforced as a HARD block at submit (audienceTzGuard
  // in validateBeforeSubmit); the operator clears it via the keyed override
  // checkbox rendered below — see feedback_operator_autonomy_with_guardrails.
  const detection = useMemo(() => detectAudienceCountry(parsedNumbers), [parsedNumbers]);
  const recommendedTz = allowedTimezonesForCountry(detection.country);
  const tzMismatch =
    recommendedTz != null && !recommendedTz.includes(state.timezone);

  return (
    <div className="flex-1 flex flex-col">
      <h1 className="text-[22px] font-bold tracking-tight">Who are you calling?</h1>
      <p className="text-sm text-[var(--text-3)] mt-1.5 leading-relaxed">
        Start with the audience — Voizo derives location, timezone, and recommended hours from
        your segment so you don&apos;t have to.
      </p>

      <div className="mt-7 flex flex-col gap-[18px]">
        {/* Campaign name */}
        <div className="flex flex-col gap-2">
          <FieldLabel required htmlFor="wizard-name">
            Campaign name
          </FieldLabel>
          <input
            id="wizard-name"
            type="text"
            value={state.name}
            onChange={(e) =>
              dispatch({ type: "SET_AUDIENCE_FIELDS", payload: { name: e.target.value } })
            }
            placeholder="e.g. Lucky7 Reactivation · CA · 19/05/2026"
            className="px-3.5 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] text-sm placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-colors"
          />
          <p className="text-[11px] text-[var(--text-3)] mt-[-2px]">
            A descriptive name helps you find this in the campaigns list later.
          </p>
          <label className="flex items-start gap-2 cursor-pointer select-none mt-1">
            <input
              type="checkbox"
              checked={state.isTest}
              onChange={(e) =>
                dispatch({ type: "SET_AUDIENCE_FIELDS", payload: { isTest: e.target.checked } })
              }
              className="mt-[2px] accent-blue-500"
            />
            <span className="text-[11px] text-[var(--text-3)] leading-snug">
              Mark as test campaign
              <span className="text-[var(--text-3)] opacity-70"> — excluded from Audience suggestions. You can change this any time on the campaign detail page.</span>
            </span>
          </label>
        </div>

        {/* 2026-05-22: Step 1 source picker — three-tab strip. The active tab
            swaps the picker below; each tab's selection is preserved in its
            own WizardState fields (cioPhones / voizoPhones / manualPhones)
            so flipping tabs doesn't lose work. */}
        <div className="flex flex-col gap-3">
          <FieldLabel required>Audience source</FieldLabel>

          {/* Tab strip */}
          <div className="inline-flex items-center gap-0.5 p-0.5 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg self-start">
            {([
              { key: "cio",    label: "Customer.io" },
              { key: "voizo",  label: "Voizo" },
              { key: "manual", label: "Paste manually" },
            ] as const).map((tab) => {
              const active = state.audienceSource === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() =>
                    dispatch({
                      type: "SET_AUDIENCE_FIELDS",
                      payload: { audienceSource: tab.key },
                    })
                  }
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    active
                      ? "bg-[var(--bg-card)] text-[var(--text-1)] shadow-sm"
                      : "text-[var(--text-3)] hover:text-[var(--text-2)]"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* CIO picker */}
          {state.audienceSource === "cio" && (
            <>
              <SegmentImporter
                singleSelectOnly={state.campaignType === "recurring"}
                onImport={(phones, segmentId, segmentName) =>
                  dispatch({
                    type: "IMPORT_SEGMENT",
                    payload: { phones, segmentId, segmentName },
                  })
                }
              />
              {state.segmentName && state.segmentId != null && (
                <div className="px-3 py-2 rounded-lg bg-blue-500/[0.06] border border-blue-500/20 text-xs text-[var(--text-2)] inline-flex items-start gap-1.5">
                  <Users size={12} className="mt-0.5 text-blue-400 shrink-0" />
                  <span>
                    Selected: <span className="text-[var(--text-1)] font-medium">{state.segmentName}</span>
                    <span className="text-[var(--text-3)]"> · id {state.segmentId} · {parsedNumbers.length} number{parsedNumbers.length === 1 ? "" : "s"}</span>
                  </span>
                </div>
              )}
            </>
          )}

          {/* Voizo picker */}
          {state.audienceSource === "voizo" && (
            <>
              <VoizoSegmentImporter
                selectedId={state.voizoSegmentId}
                onImport={(phones, segmentId, segmentName) =>
                  dispatch({
                    type: "SET_AUDIENCE_FIELDS",
                    payload: {
                      voizoSegmentId: segmentId,
                      voizoSegmentName: segmentName,
                      voizoPhones: phones.join("\n"),
                      numbersText: phones.join("\n"),
                    },
                  })
                }
              />
              {state.voizoSegmentName && state.voizoSegmentId != null && (
                <div className="px-3 py-2 rounded-lg bg-blue-500/[0.06] border border-blue-500/20 text-xs text-[var(--text-2)] inline-flex items-start gap-1.5">
                  <Users size={12} className="mt-0.5 text-blue-400 shrink-0" />
                  <span>
                    Selected: <span className="text-[var(--text-1)] font-medium">{state.voizoSegmentName}</span>
                    <span className="text-[var(--text-3)]"> · {parsedNumbers.length} phone{parsedNumbers.length === 1 ? "" : "s"}</span>
                  </span>
                </div>
              )}
            </>
          )}

          {/* Manual paste */}
          {state.audienceSource === "manual" && (
            <>
              {/* Slice 4 banner — Recycled · segments arriving via Audience-tab
                  prefill. Kept for back-compat when older prefill paths land
                  on the manual tab; new Audience-tab entry lands on Voizo tab. */}
              {state.segmentName?.startsWith("Recycled · ") && (
                <div className="px-3 py-2 rounded-lg bg-amber-500/[0.06] border border-amber-500/25 text-xs text-[var(--text-2)] inline-flex items-start gap-1.5">
                  <Users size={12} className="mt-0.5 text-amber-400 shrink-0" />
                  <span>
                    Imported from Audience: <span className="text-[var(--text-1)] font-medium">{state.segmentName.replace(/^Recycled · /, "")}</span>
                    <span className="text-[var(--text-3)]"> · {parsedNumbers.length} phone{parsedNumbers.length === 1 ? "" : "s"} · DNC-scrubbed at carve</span>
                  </span>
                </div>
              )}

              {/* 2026-05-21: Duplicate-via-Wizard banner. The detail-page modal
                  already showed the operator the diff; this is a quiet reminder
                  inside the wizard of what was carried over + what got skipped. */}
              {state.segmentName?.startsWith("Duplicated from ") && (
                <div className="px-3 py-2 rounded-lg bg-indigo-500/[0.08] border border-indigo-500/30 text-xs text-[var(--text-2)] inline-flex items-start gap-1.5">
                  <Users size={12} className="mt-0.5 text-indigo-400 shrink-0" />
                  <span>
                    Duplicated from{" "}
                    <span className="text-[var(--text-1)] font-medium">
                      {state.segmentName.replace(/^Duplicated from /, "")}
                    </span>
                    <span className="text-[var(--text-3)]">
                      {" · "}{parsedNumbers.length} phone{parsedNumbers.length === 1 ? "" : "s"}
                      {duplicateSkipped && duplicateSkipped.total > duplicateSkipped.shown && (
                        <>
                          {" · "}
                          {duplicateSkipped.total - duplicateSkipped.shown} skipped
                          {duplicateSkipped.appliedSkips.length > 0 && (
                            <> ({duplicateSkipped.appliedSkips.join(", ")})</>
                          )}
                        </>
                      )}
                    </span>
                  </span>
                </div>
              )}

              <textarea
                value={state.numbersText}
                onChange={(e) =>
                  dispatch({
                    type: "SET_AUDIENCE_FIELDS",
                    payload: { numbersText: e.target.value },
                  })
                }
                rows={5}
                placeholder={"Paste or type numbers here, one per line\ne.g. +14035550100"}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-y font-mono text-sm transition-colors"
              />
              {hasInvalidContent ? (
                <p className="text-xs text-red-400">
                  No valid E.164 numbers found. Numbers must start with + followed by 8–15 digits.
                </p>
              ) : parsedNumbers.length > 0 ? (
                <p className="text-xs text-emerald-400">
                  {parsedNumbers.length} valid number{parsedNumbers.length === 1 ? "" : "s"}
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* Auto-detected timezone banner + override select */}
        <div className="flex flex-col gap-2">
          <FieldLabel>Timezone</FieldLabel>

          {/* Country-aware guardrail banner — shown only when ≥80% of sampled
              phones share a country prefix. Above the existing TZ banner so
              the lock reason precedes the calling-window detail. */}
          {detection.country && (
            <div className={`px-3.5 py-3 rounded-xl border text-[12px] text-[var(--text-2)] leading-relaxed flex items-start gap-2 ${
              detection.confidence >= 1 && !tzMismatch
                ? "bg-emerald-500/[0.08] border-emerald-500/30"
                : "bg-amber-500/[0.08] border-amber-500/30"
            }`}>
              <Globe2 size={13} className={`shrink-0 mt-0.5 ${detection.confidence >= 1 && !tzMismatch ? "text-emerald-400" : "text-amber-400"}`} />
              <span>
                Detected{" "}
                <span className="text-[var(--text-1)] font-semibold">
                  {countryLabel(detection.country)}
                </span>{" "}
                from {detection.sampleSize} phone{detection.sampleSize === 1 ? "" : "s"}
                {detection.confidence < 1 && (
                  <> ({Math.round(detection.confidence * 100)}% match)</>
                )}
                {recommendedTz && recommendedTz.length > 0 && (
                  <>
                    {" · recommended "}
                    <span className="text-[var(--text-1)] font-semibold">{recommendedTz[0]}</span>
                    {recommendedTz.length > 1 && (
                      <span className="text-[var(--text-3)]"> +{recommendedTz.length - 1} more</span>
                    )}
                  </>
                )}
                {tzMismatch && (
                  <>
                    {" · your pick "}
                    <span className="text-[var(--text-1)] font-mono">{state.timezone}</span>
                    <span className="text-amber-300"> isn&apos;t a {countryLabel(detection.country)} calling zone — tick below to override, or change the timezone</span>
                  </>
                )}
              </span>
            </div>
          )}

          {tzMismatch && detection.country && (() => {
            // Key format must stay in sync with audienceTzGuard's compare (audienceCountry.ts).
            const ackKey = `${detection.country}:${state.timezone}`;
            const acked = state.tzMismatchAckFor === ackKey;
            return (
              <label className="flex items-start gap-2 px-3.5 py-2.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/25 text-[12px] text-amber-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={acked}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_AUDIENCE_FIELDS",
                      payload: { tzMismatchAckFor: e.target.checked ? ackKey : null },
                    })
                  }
                  className="mt-0.5 shrink-0"
                />
                <span>
                  I understand — dial <span className="font-semibold">{countryLabel(detection.country)}</span> numbers on{" "}
                  <span className="font-mono">{state.timezone}</span> anyway.
                </span>
              </label>
            );
          })()}

          <div className="px-3.5 py-3 rounded-xl bg-blue-500/[0.06] border border-blue-500/25 text-[12px] text-[var(--text-2)] leading-relaxed flex items-start gap-2">
            <Info size={13} className="text-blue-400 shrink-0 mt-0.5" />
            <span>
              {detectedPrefix}
              <span className="text-[var(--text-1)] font-semibold">{tzLabel}</span>
              {" · calling window "}
              <span className="text-[var(--text-1)] font-semibold font-mono">
                {hours.start}–{hours.end}
              </span>
              {" · "}
              <span className="text-[var(--text-3)]">{hours.note}</span>
            </span>
          </div>

          <StyledSelect
            value={state.timezone}
            onChange={(value) =>
              dispatch({ type: "SET_AUDIENCE_FIELDS", payload: { timezone: value } })
            }
            options={TIMEZONE_OPTIONS}
            icon={<Globe2 size={14} />}
            placeholder="Pick a timezone…"
          />
          <p className="text-[11px] text-[var(--text-3)]">
            Voizo enforces this calling window every day, and the per-day call hours on Step 3
            default to it (you can override there).
          </p>
        </div>
      </div>

      {/* Spacer so the dashed line / footer don't crowd the last field */}
      <div className="mt-4 text-[11px] text-[var(--text-3)] inline-flex items-center gap-1.5">
        <Clock size={11} />
        Next: pick the AI assistant.
      </div>
    </div>
  );
}

function FieldLabel({
  children,
  required,
  htmlFor,
}: {
  children: React.ReactNode;
  required?: boolean;
  htmlFor?: string;
}) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-[var(--text-2)]">
      {children}
      {required && <span className="text-red-400 ml-0.5">*</span>}
    </label>
  );
}
