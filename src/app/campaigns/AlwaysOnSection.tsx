"use client";

// Always-on campaigns control section (post-VOZ-132 ops, 2026-07-10).
//
// One row per recurring/real-time PARENT + its latest child, with the three
// controls the flat list can't offer:
//   1. Compound Stop — pauses the parent AND today's child together, killing
//      the parent/child footgun (child-only pause respawns tomorrow;
//      parent-only pause keeps dialing today; a DRAFT child would even
//      auto-start later unless flipped too).
//   2. Resume schedule — parent status flip (parents hold no clone/slot, so a
//      soft flip is the blessed path per the /status route).
//   3. Settings drawer — next-child knobs PATCHed onto the parent row;
//      children copy the parent at every spawn, so edits apply from
//      tomorrow's campaign with no deploy.
//
// Renders null when no running/paused recurring parents exist — the section
// is invisible in today's prod until the first one is created.

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Globe2, Loader2, Pause, Play, Repeat, Settings, Zap } from "lucide-react";
import { deriveAlwaysOnRows, type AlwaysOnRow } from "@/lib/alwaysOn";
import { patchCampaignSettings, updateCampaignV2Status } from "@/lib/campaignV2Client";
import { resolveCallDelay } from "@/lib/campaignV2Shared";
import { RecurrenceEditor, defaultRecurrencePattern } from "@/components/RecurrenceEditor";
import StyledSelect from "@/components/StyledSelect";
import { validateRecurrencePattern, type RecurrencePattern } from "@/lib/types/recurrence";
import { TIMEZONE_OPTIONS } from "./v2/new/wizardState";

type CampaignRow = Record<string, unknown>;

interface Props {
  campaigns: CampaignRow[];
  /** The page's setCampaigns — local optimistic updates after actions. */
  onMutate: (updater: (prev: CampaignRow[]) => CampaignRow[]) => void;
}

const RETRY_GAP_PRESETS = [30, 60, 90] as const;
const MAX_TRIES_PRESETS = [2, 3, 4, 5] as const;
const CALL_DELAY_PRESETS: ReadonlyArray<{ choice: "now" | "5" | "30" | "60" | "custom"; label: string }> = [
  { choice: "now", label: "Right away" },
  { choice: "5", label: "After 5 min" },
  { choice: "30", label: "After 30 min" },
  { choice: "60", label: "After 1 hour" },
  { choice: "custom", label: "Custom" },
];

interface SettingsDraft {
  retryGap: number;
  maxTries: number;
  dailyCapText: string;
  lastResortText: string;
  callDelayChoice: "now" | "5" | "30" | "60" | "custom";
  callDelayCustomText: string;
  recurrencePattern: RecurrencePattern;
  timezone: string;
}

export default function AlwaysOnSection({ campaigns, onMutate }: Props) {
  const rows = deriveAlwaysOnRows(campaigns);
  const [actionId, setActionId] = useState<string | null>(null);
  const [openSettingsId, setOpenSettingsId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  if (rows.length === 0) return null;

  function localPatch(id: string, patch: Record<string, unknown>) {
    onMutate((prev) => prev.map((c) => ((c.id as string) === id ? { ...c, ...patch } : c)));
  }

  async function handleStopAlwaysOn(row: AlwaysOnRow) {
    const parent = row.parent;
    const child = row.latestChild;
    const childStatus = (child?.status as string) ?? null;
    const willStopChild = childStatus === "running" || childStatus === "draft";
    const ok = window.confirm(
      willStopChild
        ? "Stop this campaign? Today's calls stop and it won't run again until you resume."
        : "Stop this campaign? It won't run again until you resume.",
    );
    if (!ok) return;

    setActionId(parent.id as string);
    setRowError(null);
    try {
      // Parent first: the schedule is the thing being stopped; if the child
      // half fails we surface it, but tomorrow is already safe.
      await updateCampaignV2Status(parent.id as string, "paused");
      localPatch(parent.id as string, { status: "paused" });

      if (child && childStatus === "running") {
        // House kill for a live campaign: cancels queued work, in-flight
        // call ends naturally (~60s) — same action as the list's Stop.
        const res = await fetch(`/api/campaigns-v2/${child.id as string}/stop`, { method: "POST" });
        if (!res.ok && res.status !== 409) throw new Error(`Stopping today's run failed (${res.status})`);
        localPatch(child.id as string, { status: "paused" });
      } else if (child && childStatus === "draft") {
        // A draft child auto-starts at window-open INDEPENDENT of the parent —
        // it must be flipped too or "stopped" quietly un-stops itself today.
        await updateCampaignV2Status(child.id as string, "paused");
        localPatch(child.id as string, { status: "paused" });
      }
    } catch (err) {
      console.error("[always-on] stop failed:", err);
      setRowError({
        id: parent.id as string,
        message: err instanceof Error ? err.message : "Stop failed. Check the campaign pages.",
      });
    } finally {
      setActionId(null);
    }
  }

  async function handleResumeParent(parent: CampaignRow) {
    setActionId(parent.id as string);
    setRowError(null);
    try {
      await updateCampaignV2Status(parent.id as string, "running");
      localPatch(parent.id as string, { status: "running" });
    } catch (err) {
      console.error("[always-on] resume failed:", err);
      setRowError({
        id: parent.id as string,
        message: err instanceof Error ? err.message : "Resume failed.",
      });
    } finally {
      setActionId(null);
    }
  }

  function toggleSettings(parent: CampaignRow) {
    const id = parent.id as string;
    if (openSettingsId === id) {
      setOpenSettingsId(null);
      setDraft(null);
      return;
    }
    setOpenSettingsId(id);
    setRowError(null);
    const delay = (parent.call_delay_minutes as number | null) ?? null;
    setDraft({
      retryGap: (parent.retry_interval_minutes as number) ?? 90,
      maxTries: (parent.max_attempts as number) ?? 3,
      dailyCapText: parent.daily_cap != null ? String(parent.daily_cap) : "",
      lastResortText: (parent.sms_last_resort_template as string) ?? "",
      callDelayChoice:
        delay == null ? "now" : delay === 5 || delay === 30 || delay === 60 ? (String(delay) as "5" | "30" | "60") : "custom",
      callDelayCustomText: delay != null && ![5, 30, 60].includes(delay) ? String(delay) : "",
      recurrencePattern:
        (parent.recurrence_pattern as RecurrencePattern | null) ??
        defaultRecurrencePattern(new Date(), (parent.timezone as string) ?? "UTC"),
      timezone: (parent.timezone as string) ?? "UTC",
    });
  }

  async function handleSaveSettings(parent: CampaignRow) {
    if (!draft) return;
    const id = parent.id as string;
    const isRealtime = parent.realtime === true;
    const capTrimmed = draft.dailyCapText.trim();
    const capNumber = capTrimmed === "" ? null : Number(capTrimmed);
    if (capNumber !== null && (!Number.isInteger(capNumber) || capNumber <= 0)) {
      setRowError({ id, message: "Daily cap must be a whole number above 0, or empty for no cap." });
      return;
    }
    if (isRealtime && capNumber === null) {
      setRowError({ id, message: "Real-time campaigns need a daily cap." });
      return;
    }
    const delay = resolveCallDelay(draft.callDelayChoice, draft.callDelayCustomText);
    if (isRealtime && delay.invalid) {
      setRowError({
        id,
        message: "Custom call delay must be a whole number of minutes between 1 and 1440 (24 hours).",
      });
      return;
    }

    // Schedule: validate, and gate the timezone change (the server also blocks
    // it while today's run is still active — that 409 surfaces as rowError).
    const recErrors = validateRecurrencePattern(draft.recurrencePattern).errors;
    if (recErrors.length > 0) {
      setRowError({ id, message: recErrors[0] });
      return;
    }
    const patternChanged =
      JSON.stringify(draft.recurrencePattern) !== JSON.stringify(parent.recurrence_pattern ?? null);
    const timezoneChanged = draft.timezone !== ((parent.timezone as string) ?? "UTC");
    if (
      timezoneChanged &&
      !window.confirm(
        "Change the timezone? Day boundaries and legal calling hours shift with it, from the next run. To call a different country, create a new campaign instead.",
      )
    ) {
      return;
    }

    setActionId(id);
    setRowError(null);
    try {
      const updated = await patchCampaignSettings(id, {
        retryIntervalMinutes: draft.retryGap,
        maxAttempts: draft.maxTries,
        dailyCap: capNumber,
        ...(isRealtime ? { callDelayMinutes: delay.minutes } : {}),
        ...(parent.sms_consent_mode === "registered_optin"
          ? { smsLastResortTemplate: draft.lastResortText.trim() || null }
          : {}),
        ...(patternChanged ? { recurrencePattern: draft.recurrencePattern } : {}),
        ...(timezoneChanged ? { timezone: draft.timezone } : {}),
      });
      localPatch(id, updated);
      setOpenSettingsId(null);
      setDraft(null);
    } catch (err) {
      console.error("[always-on] settings save failed:", err);
      setRowError({
        id,
        message: err instanceof Error ? err.message : "Saving settings failed.",
      });
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="rounded-2xl border-[1.5px] border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
      <div className="px-4 pt-3.5 pb-2.5">
        <div className="text-sm font-semibold text-[var(--text-1)]">Always-on campaigns</div>
        <p className="text-xs text-[var(--text-3)] mt-0.5">
          Stop ends today&apos;s calls and tomorrow&apos;s run. Settings changes start tomorrow.
        </p>
      </div>
      <div className="divide-y divide-[var(--border)]">
        {rows.map((row) => {
          const parent = row.parent;
          const parentId = parent.id as string;
          const isRealtime = parent.realtime === true;
          const parentRunning = (parent.status as string) === "running";
          const child = row.latestChild;
          const childStatus = (child?.status as string) ?? null;
          const busy = actionId === parentId;
          const settingsOpen = openSettingsId === parentId;

          return (
            <div key={parentId} className="px-4 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold shrink-0 ${
                    isRealtime ? "bg-amber-500/15 text-amber-300" : "bg-blue-500/15 text-blue-300"
                  }`}
                >
                  {isRealtime ? <Zap size={11} /> : <Repeat size={11} />}
                  {isRealtime ? "Real-time" : "Repeat daily"}
                </span>

                <div className="min-w-0 flex-1">
                  <Link
                    href={`/campaigns/v2/${parentId}`}
                    className="text-sm font-medium text-[var(--text-1)] hover:text-blue-400 transition truncate block"
                  >
                    {(parent.name as string) ?? parentId}
                  </Link>
                  <p className="text-[11px] text-[var(--text-3)] mt-0.5 truncate">
                    {parentRunning ? (
                      <span className="text-emerald-400">Schedule live</span>
                    ) : (
                      <span>Schedule paused</span>
                    )}
                    {" · "}
                    {child ? (
                      <>
                        today&apos;s run:{" "}
                        <Link
                          href={`/campaigns/v2/${child.id as string}`}
                          className="underline decoration-dotted hover:text-[var(--text-2)]"
                        >
                          {childStatus}
                        </Link>
                        {childStatus === "paused" && parentRunning && (
                          <span> (resume it from its page)</span>
                        )}
                      </>
                    ) : (
                      <span>no run today yet</span>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => toggleSettings(parent)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:border-[var(--border-2)] transition"
                  >
                    <Settings size={12} />
                    Settings
                    <ChevronDown size={12} className={`transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
                  </button>
                  {parentRunning ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleStopAlwaysOn(row)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20 transition disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <Pause size={12} />}
                      Stop campaign
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleResumeParent(parent)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 transition disabled:opacity-50"
                    >
                      {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                      Resume schedule
                    </button>
                  )}
                </div>
              </div>

              {rowError?.id === parentId && (
                <p className="text-[11px] text-red-400 mt-2">{rowError.message}</p>
              )}

              {settingsOpen && draft && (
                <div className="mt-3 p-3.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] flex flex-col gap-3">
                  {/* Schedule + timezone (inline, 2026-07-13). Applies from
                      tomorrow's run; the timezone change is confirm-gated and
                      the server blocks it while today's run is still active. */}
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] font-medium text-[var(--text-2)]">Schedule</span>
                    <RecurrenceEditor
                      value={draft.recurrencePattern}
                      onChange={(pattern) => setDraft({ ...draft, recurrencePattern: pattern })}
                      campaignTimezone={draft.timezone}
                      errors={validateRecurrencePattern(draft.recurrencePattern).errors}
                      timezoneSlot={
                        <StyledSelect
                          value={draft.timezone}
                          onChange={(value) => setDraft({ ...draft, timezone: value })}
                          options={TIMEZONE_OPTIONS}
                          icon={<Globe2 size={14} />}
                          placeholder="Pick a timezone…"
                        />
                      }
                    />
                  </div>

                  <div className="flex flex-col gap-1.5" role="group" aria-label="Retry gap">
                    <span className="text-[11px] font-medium text-[var(--text-2)]">
                      Retry gap
                    </span>
                    <div className="flex gap-1.5">
                      {RETRY_GAP_PRESETS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setDraft({ ...draft, retryGap: v })}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                            draft.retryGap === v
                              ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                              : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30"
                          }`}
                        >
                          {v} min
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5" role="group" aria-label="Max tries per player">
                    <span className="text-[11px] font-medium text-[var(--text-2)]">Max tries per player</span>
                    <div className="flex gap-1.5">
                      {MAX_TRIES_PRESETS.map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => setDraft({ ...draft, maxTries: v })}
                          className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                            draft.maxTries === v
                              ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                              : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30"
                          }`}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`cap-${parentId}`} className="text-[11px] font-medium text-[var(--text-2)]">
                      Daily cap
                      <span className="text-[var(--text-3)] font-normal">
                        {isRealtime ? " (required for real-time)" : " (empty = no cap)"}
                      </span>
                    </label>
                    <input
                      id={`cap-${parentId}`}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      value={draft.dailyCapText}
                      onChange={(e) => setDraft({ ...draft, dailyCapText: e.target.value })}
                      placeholder={isRealtime ? "e.g. 150" : "no cap"}
                      className="w-full sm:max-w-[10rem] px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
                    />
                  </div>

                  {isRealtime && draft && (
                    <div className="flex flex-col gap-1.5" role="group" aria-label="Call new sign-ups">
                      <span className="text-[11px] font-medium text-[var(--text-2)]">Call new sign-ups</span>
                      <div className="flex gap-1.5 flex-wrap">
                        {CALL_DELAY_PRESETS.map((p) => (
                          <button
                            key={p.choice}
                            type="button"
                            onClick={() => setDraft({ ...draft, callDelayChoice: p.choice })}
                            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition ${
                              draft.callDelayChoice === p.choice
                                ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                                : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30"
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      {draft.callDelayChoice === "custom" && (
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={1440}
                          step={1}
                          value={draft.callDelayCustomText}
                          onChange={(e) => setDraft({ ...draft, callDelayCustomText: e.target.value })}
                          placeholder="minutes, e.g. 45"
                          aria-label="Custom call delay in minutes"
                          className="w-full sm:max-w-[10rem] px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
                        />
                      )}
                      <p className="text-[11px] text-[var(--text-3)]">Applies from the next check, not tomorrow.</p>
                    </div>
                  )}

                  {parent.sms_consent_mode === "registered_optin" && (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor={`lr-${parentId}`} className="text-[11px] font-medium text-[var(--text-2)]">
                        Last-resort text
                        <span className="text-[var(--text-3)] font-normal">
                          {" "}(sent after the last failed try; empty = off)
                        </span>
                      </label>
                      <textarea
                        id={`lr-${parentId}`}
                        rows={2}
                        value={draft.lastResortText}
                        onChange={(e) => setDraft({ ...draft, lastResortText: e.target.value })}
                        placeholder="Empty = off"
                        className="w-full px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 resize-none transition"
                      />
                    </div>
                  )}

                  <div className="flex items-center gap-2.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleSaveSettings(parent)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-500 text-white hover:bg-blue-600 transition disabled:opacity-50"
                    >
                      {busy && <Loader2 size={12} className="animate-spin" />}
                      Save
                    </button>
                    <p className="text-[11px] text-[var(--text-3)]">
                      Takes effect from tomorrow&apos;s run.
                    </p>
                    <Link
                      href={`/campaigns/v2/${parentId}/edit`}
                      className="ml-auto text-[11px] text-blue-400 hover:text-blue-300 transition"
                    >
                      Edit campaign (schedule, audience, more)
                    </Link>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
