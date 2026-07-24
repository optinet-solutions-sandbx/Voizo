"use client";

import { useMemo, type Dispatch } from "react";
import {
  AlertTriangle, Bot, CalendarDays, MessageSquareText, Play, Repeat, Users,
} from "lucide-react";

import { parsePhoneList } from "@/lib/campaignV2Shared";
import { DEFAULT_WS } from "@/components/SegmentImporter";

import {
  DAYS, getCallingHours, SHORTENED_URL_LENGTH, smsSegmentCount, TIMEZONE_OPTIONS,
  validateBeforeSubmit,
  type Step, type WizardAction, type WizardState,
} from "../wizardState";
import { VOICE_OPTIONS } from "@/lib/voiceOptions";

interface Props {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
}

function formatLocalTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
      timeZone,
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
}

export default function StepReview({ state, dispatch }: Props) {
  const tzLabel =
    TIMEZONE_OPTIONS.find((o) => o.value === state.timezone)?.label ?? state.timezone;
  const tzHours = getCallingHours(state.timezone);
  const parsedNumbers = useMemo(() => parsePhoneList(state.numbersText), [state.numbersText]);

  const isRecurring = state.campaignType === "recurring";

  const enabledDays = state.scheduleRows.filter((r) => r.enabled);
  const recurringDays = state.recurrencePattern.days_of_week;

  const validationError = validateBeforeSubmit(state);

  // Delay-mode auto-start preview — `Date.now()` is impure (returns a new
  // value each call), so it can't sit in JSX directly per
  // `react-hooks/purity`. Memoize so it stays stable across render passes;
  // operators only need a glance, the displayed minute will drift slightly
  // if they linger but that's acceptable for a review screen.
  const delayStartLabel = useMemo(() => {
    if (state.startMode !== "delay") return null;
    // eslint-disable-next-line react-hooks/purity
    const startTs = Date.now() + state.delayMinutes * 60_000;
    return formatLocalTime(new Date(startTs), state.timezone);
  }, [state.startMode, state.delayMinutes, state.timezone]);

  // SMS preview composition
  const estimatedSmsLen = useMemo(() => {
    if (!state.smsEnabled) return 0;
    const msgLen = state.smsMessage.trim().length;
    const urlLen = state.smsLink.trim() ? SHORTENED_URL_LENGTH : 0;
    const optLen = state.smsOptout.trim().length;
    const spaces = (msgLen > 0 ? 1 : 0) + (urlLen > 0 ? 1 : 0);
    return msgLen + urlLen + optLen + spaces;
  }, [state.smsEnabled, state.smsMessage, state.smsLink, state.smsOptout]);
  const smsSegs = smsSegmentCount(estimatedSmsLen);

  function jump(step: Step) {
    dispatch({ type: "GOTO_STEP", step });
  }

  return (
    <div className="flex-1 flex flex-col">
      <h1 className="text-[22px] font-bold tracking-tight">Ready to launch?</h1>
      <p className="text-sm text-[var(--text-3)] mt-1.5 leading-relaxed">
        Last look. Nothing dials until you tap Launch. You&apos;ll still get one more confirm
        on the campaign page after.
      </p>

      <div className="mt-7 flex flex-col gap-3">
        {/* AUDIENCE */}
        <ReviewCard title="Audience" icon={<Users size={13} />} onEdit={() => jump(1)}>
          <ReviewRow label="Name" value={state.name || <em className="text-[var(--text-3)]">required</em>} />
          <ReviewRow
            label="Segment"
            value={
              state.segmentName ? (
                <>
                  {state.segmentName}
                  <span className="text-[var(--text-3)] ml-1.5">
                    · id {state.segmentId}
                    {state.cioWorkspace && state.cioWorkspace !== DEFAULT_WS ? ` · brand ${state.cioWorkspace}` : ""}
                  </span>
                </>
              ) : parsedNumbers.length > 0 ? (
                <>{parsedNumbers.length.toLocaleString()} manual number{parsedNumbers.length === 1 ? "" : "s"}</>
              ) : (
                <em className="text-amber-300">pick a segment or paste numbers</em>
              )
            }
          />
          <ReviewRow
            label="Timezone"
            value={
              <>
                {tzLabel}
                <span className="text-[var(--text-3)] ml-1.5 font-mono">· {tzHours.start}–{tzHours.end}</span>
              </>
            }
          />
        </ReviewCard>

        {/* AGENT / SCRIPT */}
        <ReviewCard title={state.agentMode === "script" ? "Script" : "Agent"} icon={<Bot size={13} />} onEdit={() => jump(2)}>
          {state.agentMode === "script" ? (
            <>
              <ReviewRow
                label="Script"
                value={state.scriptName ? <span className="text-[12px] text-[var(--text-2)]">{state.scriptName}</span> : <em className="text-amber-300">required</em>}
              />
              <ReviewRow
                label="Base agent"
                value={
                  state.vapiAssistantId.trim() ? (
                    state.vapiAssistantName ? (
                      <span className="text-[12px] text-[var(--text-2)]">{state.vapiAssistantName}</span>
                    ) : (
                      <span className="font-mono text-[12px]">{state.vapiAssistantId}</span>
                    )
                  ) : (
                    <span className="text-[12px] text-[var(--text-3)]">Standard (default)</span>
                  )
                }
              />
            </>
          ) : (
            <ReviewRow
              label="Assistant"
              value={
                state.vapiAssistantId ? (
                  state.vapiAssistantName ? (
                    <span className="text-[12px] text-[var(--text-2)]">{state.vapiAssistantName}</span>
                  ) : (
                    <span className="font-mono text-[12px]">{state.vapiAssistantId}</span>
                  )
                ) : (
                  <em className="text-amber-300">required</em>
                )
              }
            />
          )}
          {/* Voice provenance is mode-specific: in script mode the voice row is
              truthful ONLY when a base agent is explicitly picked (VOZ-168 —
              the pick rides the clone request, so its voice is what launches).
              Unpicked script mode clones the standard base; no row. */}
          {(state.agentMode !== "script" || Boolean(state.vapiAssistantId.trim())) && state.baseVoiceId && (
            <ReviewRow
              label="Voice"
              value={
                <>
                  {VOICE_OPTIONS.find((v) => v.id === state.baseVoiceId)?.name ? (
                    <span className="text-[12px] text-[var(--text-2)]">
                      {VOICE_OPTIONS.find((v) => v.id === state.baseVoiceId)?.name}
                    </span>
                  ) : (
                    <span className="text-[12px] text-[var(--text-2)]">
                      Custom voice <span className="font-mono text-[11px] text-[var(--text-3)]">({state.baseVoiceId})</span>
                    </span>
                  )}
                  <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--text-3)] bg-[var(--bg-app)] px-1.5 py-0.5 rounded font-medium">Locked</span>
                </>
              }
            />
          )}
          {(state.agentMode === "script" ? state.persona : state.systemPrompt) && (
            <ReviewRow
              label={state.agentMode === "script" ? "Persona" : "Prompt"}
              value={
                <span className="text-[12px] text-[var(--text-2)] leading-relaxed line-clamp-2">
                  {state.agentMode === "script" ? state.persona : state.systemPrompt}
                </span>
              }
            />
          )}
        </ReviewCard>

        {/* SCHEDULE */}
        <ReviewCard
          title="Schedule"
          icon={isRecurring ? <Repeat size={13} /> : <CalendarDays size={13} />}
          onEdit={() => jump(3)}
        >
          <ReviewRow label="Mode" value={isRecurring ? "Repeat daily" : "Run once"} />

          {isRecurring ? (
            <>
              <ReviewRow
                label="Days"
                value={
                  recurringDays.length === 0 ? (
                    <em className="text-amber-300">pick at least one day</em>
                  ) : (
                    <span className="font-mono uppercase tracking-wider text-[12px]">
                      {recurringDays.join(" · ")}
                    </span>
                  )
                }
              />
              <ReviewRow
                label="Start"
                value={<span className="font-mono">{state.recurrencePattern.start_date}</span>}
              />
              <ReviewRow
                label="Until"
                value={
                  state.recurrencePattern.end_kind === "never"
                    ? "Further notice"
                    : state.recurrencePattern.end_kind === "on_date"
                      ? <span className="font-mono">{state.recurrencePattern.end_date ?? "—"}</span>
                      : `${state.recurrencePattern.end_after_n ?? "—"} occurrences`
                }
              />
              <ReviewRow
                label="Refresh"
                value={
                  <span className="font-mono">
                    daily at {state.recurrencePattern.segment_refresh_time} {tzLabel}
                  </span>
                }
              />
            </>
          ) : (
            <>
              <ReviewRow
                label="Days"
                value={
                  enabledDays.length === 0 ? (
                    <em className="text-amber-300">pick at least one day</em>
                  ) : (
                    <span className="font-mono uppercase tracking-wider text-[12px]">
                      {enabledDays.map((r) => DAYS.find((d) => d.key === r.day)?.short ?? r.day).join(" · ")}
                    </span>
                  )
                }
              />
              {enabledDays.length > 0 && (
                <ReviewRow
                  label="Hours"
                  value={
                    enabledDays.every((r) => r.start === enabledDays[0].start && r.end === enabledDays[0].end) ? (
                      <span className="font-mono">{enabledDays[0].start}–{enabledDays[0].end}</span>
                    ) : (
                      <span className="font-mono">varies per day</span>
                    )
                  }
                />
              )}
              <ReviewRow
                label="Start"
                value={
                  state.startMode === "now" ? (
                    "Saves as draft · manual start"
                  ) : state.startMode === "delay" ? (
                    <>
                      In {state.delayMinutes} min
                      {delayStartLabel && (
                        <span className="text-[var(--text-3)] ml-1.5 font-mono">· {delayStartLabel}</span>
                      )}
                    </>
                  ) : state.scheduledDate ? (
                    <span className="font-mono">{formatLocalTime(new Date(state.scheduledDate), state.timezone)}</span>
                  ) : (
                    <em className="text-amber-300">pick a date</em>
                  )
                }
              />
              <ReviewRow
                label="Numbers"
                value={
                  parsedNumbers.length === 0 ? (
                    <em className="text-amber-300">add at least one</em>
                  ) : (
                    `${parsedNumbers.length.toLocaleString()} valid E.164`
                  )
                }
              />
            </>
          )}
        </ReviewCard>

        {/* FOLLOW-UP */}
        <ReviewCard title="Follow-up" icon={<MessageSquareText size={13} />} onEdit={() => jump(4)}>
          {!state.smsEnabled ? (
            <ReviewRow label="Post-call SMS" value={<em className="text-[var(--text-3)]">Disabled</em>} />
          ) : (
            <>
              <ReviewRow
                label="Post-call SMS"
                value={
                  <>
                    Enabled
                    <span className={`ml-2 font-mono text-[11px] ${
                      smsSegs > 2 ? "text-red-400" : smsSegs > 1 ? "text-amber-400" : "text-emerald-400"
                    }`}>
                      ~{estimatedSmsLen} chars · {smsSegs} SMS
                    </span>
                  </>
                }
              />
              <ReviewRow
                label="Send timing"
                value={state.smsConsentMode === "registered_optin"
                  ? "To everyone reached (list opted in at signup)"
                  : "Only after the customer says yes on the call"}
              />
              <ReviewRow
                label="Message"
                value={<span className="text-[12px] text-[var(--text-2)] leading-relaxed line-clamp-2">{state.smsMessage}</span>}
              />
            </>
          )}
        </ReviewCard>

        {/* Inline validation (matches what handleSubmit will refuse) */}
        {validationError && (
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-3 inline-flex items-start gap-2.5">
            <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-amber-300">Fix one thing before launch</div>
              <p className="text-xs text-amber-200/80 mt-0.5">{validationError}</p>
            </div>
          </div>
        )}

        {/* Submit error (from clone-assistant or createCampaignV2) */}
        {state.error && (
          <div className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 inline-flex items-start gap-2.5">
            <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-red-300">Launch failed</div>
              <p className="text-xs text-red-200/80 mt-0.5">{state.error}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[var(--text-3)]">
          <Play size={11} />
          {isRecurring
            ? "Launching a repeating campaign. A new run starts at the refresh time each scheduled day."
            : "Launching creates the campaign; you'll be taken to its page where the operator can Start."}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function ReviewCard({
  title, icon, onEdit, children,
}: {
  title: string;
  icon: React.ReactNode;
  onEdit: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="p-[18px] rounded-2xl border border-[var(--border)] bg-[var(--bg-card)]">
      <div className="flex items-center justify-between mb-3">
        <div className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-1)]">
          <span className="text-[var(--text-3)]">{icon}</span>
          {title}
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="text-[11px] text-blue-400 px-2 py-1 rounded-md hover:bg-[var(--bg-elevated)] transition"
        >
          Edit
        </button>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 items-baseline">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold">
        {label}
      </span>
      <span className="text-sm text-[var(--text-1)] min-w-0">{value}</span>
    </div>
  );
}
