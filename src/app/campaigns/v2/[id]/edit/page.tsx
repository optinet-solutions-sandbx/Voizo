"use client";

// /campaigns/v2/[id]/edit — edit page for recurring/real-time PARENTS
// (2026-07-13, Jas-approved design; plan docs/superpowers/plans/2026-07-13-alwayson-edit-ui.md).
//
// Wizard look-and-feel by reusing the wizard's shared pieces (RecurrenceEditor,
// SegmentImporter, StyledSelect, pill groups) laid out as SECTIONS with one
// Save — not a stepper. Every edit applies from tomorrow's child (children copy
// the parent at spawn); the call delay is the one live-apply exception and is
// labeled as such. Prompt is VIEW-ONLY: offer wording is Maria/Jas (compliance).
//
// Save sends ONLY what changed; segment and timezone changes sit behind
// window.confirm gates (house compliance-gate pattern, StepFollowup unlockLink
// precedent). The server re-validates everything (parentEdit.ts) and blocks a
// timezone change while today's child is still active (double-spawn guard).

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, Globe2, Loader2, Save, Target, Users, Zap } from "lucide-react";

import { RecurrenceEditor, defaultRecurrencePattern } from "@/components/RecurrenceEditor";
import SegmentImporter, { DEFAULT_WS } from "@/components/SegmentImporter";
import StyledSelect from "@/components/StyledSelect";
import { patchCampaignSettings } from "@/lib/campaignV2Client";
import { resolveCallDelay } from "@/lib/campaignV2Shared";
import { resolveSegmentPresence } from "@/lib/segmentPresence";
import { validateRecurrencePattern, type RecurrencePattern } from "@/lib/types/recurrence";
import { TIMEZONE_OPTIONS } from "../../new/wizardState";

type Row = Record<string, unknown>;

const RETRY_GAP_PRESETS = [30, 60, 90] as const;
const MAX_TRIES_PRESETS = [2, 3, 4, 5] as const;
const CALL_DELAY_PRESETS: ReadonlyArray<{ choice: "now" | "5" | "30" | "60" | "custom"; label: string }> = [
  { choice: "now", label: "Right away" },
  { choice: "5", label: "After 5 min" },
  { choice: "30", label: "After 30 min" },
  { choice: "60", label: "After 1 hour" },
  { choice: "custom", label: "Custom" },
];

interface Draft {
  recurrencePattern: RecurrencePattern;
  timezone: string;
  segmentId: number | null;
  segmentName: string | null; // display only; DB stores the id
  goalTargetText: string;
  retryGap: number;
  maxTries: number;
  dailyCapText: string;
  callDelayChoice: "now" | "5" | "30" | "60" | "custom";
  callDelayCustomText: string;
  smsTemplateText: string;
  smsTemplateUnlocked: boolean;
  lastResortText: string;
}

function draftFromRow(row: Row): Draft {
  const delay = (row.call_delay_minutes as number | null) ?? null;
  return {
    recurrencePattern:
      (row.recurrence_pattern as RecurrencePattern | null) ??
      defaultRecurrencePattern(new Date(), (row.timezone as string) ?? "UTC"),
    timezone: (row.timezone as string) ?? "UTC",
    segmentId: (row.segment_id as number | null) ?? null,
    segmentName: null,
    goalTargetText: row.goal_target != null ? String(row.goal_target) : "",
    retryGap: (row.retry_interval_minutes as number) ?? 90,
    maxTries: (row.max_attempts as number) ?? 3,
    dailyCapText: row.daily_cap != null ? String(row.daily_cap) : "",
    callDelayChoice:
      delay == null ? "now" : delay === 5 || delay === 30 || delay === 60 ? (String(delay) as "5" | "30" | "60") : "custom",
    callDelayCustomText: delay != null && ![5, 30, 60].includes(delay) ? String(delay) : "",
    smsTemplateText: (row.sms_template as string) ?? "",
    smsTemplateUnlocked: false,
    lastResortText: (row.sms_last_resort_template as string) ?? "",
  };
}

export default function EditAlwaysOnCampaignPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [row, setRow] = useState<Row | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The campaign's CIO workspace (VOZ-201) — pins the segment picker to its
   *  own brand; an existing campaign is never repointed at another workspace. */
  const [campaignWs, setCampaignWs] = useState<string | null>(null);
  const [segmentMissing, setSegmentMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Campaign row FIRST, then the segment list — the list must come from
        // the campaign's OWN workspace (VOZ-201: a Fortune Play campaign's
        // segments live in the fortuneplay CIO workspace; browsing the default
        // one would false-flag its segment as deleted). Sequential on purpose.
        const campRes = await fetch(`/api/campaigns-v2/${id}`);
        if (!campRes.ok) throw new Error(`Campaign not found (${campRes.status})`);
        const data = (await campRes.json()) as Row;
        const campaignWs =
          ((data as Record<string, unknown>).cio_workspace as string | null) ?? null;

        const segRes = await fetch(
          `/api/customerio/segments${campaignWs ? `?workspace=${encodeURIComponent(campaignWs)}` : ""}`,
        );

        let segList: { id: number; name: string }[] = [];
        if (segRes.ok) {
          const segBody = (await segRes.json()) as { segments?: { id: number; name: string }[] };
          segList = segBody.segments ?? [];
        }
        const presence = resolveSegmentPresence(
          (data.segment_id as number | null) ?? null,
          segRes.ok,
          segList,
        );

        if (cancelled) return;
        setRow(data);
        setCampaignWs(campaignWs);
        setDraft({ ...draftFromRow(data), segmentName: presence.name });
        if (presence.missing) setSegmentMissing(true);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Failed to load campaign.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loadError) {
    return (
      <PageShell>
        <p className="text-sm text-red-400">{loadError}</p>
        <BackLink />
      </PageShell>
    );
  }
  if (!row || !draft) {
    return (
      <PageShell>
        <p className="text-sm text-[var(--text-3)] inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" /> Loading campaign…
        </p>
      </PageShell>
    );
  }
  if ((row.campaign_type as string) !== "recurring") {
    return (
      <PageShell>
        <p className="text-sm text-[var(--text-2)]">
          This page edits repeat and real-time campaigns only. One-time campaigns are deleted and
          recreated instead.
        </p>
        <BackLink />
      </PageShell>
    );
  }

  const isRealtime = row.realtime === true;
  const recurrenceErrors = validateRecurrencePattern(draft.recurrencePattern).errors;

  async function handleSave() {
    if (!row || !draft) return;
    setSaveError(null);

    // ── Client-side validation (server re-validates everything) ──
    if (recurrenceErrors.length > 0) {
      setSaveError("Fix the schedule errors first.");
      return;
    }
    const capTrimmed = draft.dailyCapText.trim();
    const capNumber = capTrimmed === "" ? null : Number(capTrimmed);
    if (capNumber !== null && (!Number.isInteger(capNumber) || capNumber <= 0)) {
      setSaveError("Daily cap must be a whole number above 0, or empty for no cap.");
      return;
    }
    if (isRealtime && capNumber === null) {
      setSaveError("Real-time campaigns need a daily cap.");
      return;
    }
    const delay = resolveCallDelay(draft.callDelayChoice, draft.callDelayCustomText);
    if (isRealtime && delay.invalid) {
      setSaveError("Custom call delay must be a whole number of minutes between 1 and 1440 (24 hours).");
      return;
    }
    const goalTrimmed = draft.goalTargetText.trim();
    const goalNumber = goalTrimmed === "" ? null : Number(goalTrimmed);
    if (goalNumber !== null && (!Number.isInteger(goalNumber) || goalNumber <= 0)) {
      setSaveError("Campaign goal must be a whole number above 0, or empty.");
      return;
    }

    // ── Confirm gates on the heavy changes ──
    const timezoneChanged = draft.timezone !== ((row.timezone as string) ?? "UTC");
    const segmentChanged = draft.segmentId !== ((row.segment_id as number | null) ?? null);
    if (timezoneChanged) {
      const ok = window.confirm(
        "Change the timezone? Day boundaries and legal calling hours shift with it. " +
          "It takes effect from the next run. To call a different country, create a new campaign instead.",
      );
      if (!ok) return;
    }
    if (segmentChanged) {
      const ok = window.confirm(
        "Switch the audience segment? The next run pulls the new list." +
          (isRealtime ? " People already called are remembered and will not be re-called." : ""),
      );
      if (!ok) return;
    }

    // ── Payload: knobs sent as-is (drawer parity); heavy fields only when changed ──
    const patternChanged =
      JSON.stringify(draft.recurrencePattern) !== JSON.stringify(row.recurrence_pattern ?? null);
    const smsChanged = draft.smsTemplateText.trim() !== (((row.sms_template as string) ?? "").trim());
    const payload = {
      retryIntervalMinutes: draft.retryGap,
      maxAttempts: draft.maxTries,
      dailyCap: capNumber,
      goalTarget: goalNumber,
      ...(isRealtime ? { callDelayMinutes: delay.minutes } : {}),
      ...(row.sms_consent_mode === "registered_optin"
        ? { smsLastResortTemplate: draft.lastResortText.trim() || null }
        : {}),
      ...(patternChanged ? { recurrencePattern: draft.recurrencePattern } : {}),
      ...(timezoneChanged ? { timezone: draft.timezone } : {}),
      ...(segmentChanged && draft.segmentId != null ? { segmentId: draft.segmentId } : {}),
      ...(smsChanged ? { smsTemplate: draft.smsTemplateText } : {}),
    };

    setSaving(true);
    try {
      await patchCampaignSettings(id, payload);
      router.push("/campaigns");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Saving failed.");
      setSaving(false);
    }
  }

  return (
    <PageShell>
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight inline-flex items-center gap-2">
            {isRealtime && <Zap size={18} className="text-blue-400" />}
            Edit: {(row.name as string) ?? id}
          </h1>
          <p className="text-sm text-[var(--text-3)] mt-1.5 leading-relaxed">
            Changes apply from tomorrow&apos;s run; today&apos;s run keeps its settings.
            {isRealtime && " The call delay is the exception: it applies from the next check."}
          </p>
        </div>
        <BackLink />
      </div>

      <div className="mt-6 flex flex-col gap-5">
        {/* ── Schedule ── */}
        <Section title="Schedule">
          <RecurrenceEditor
            value={draft.recurrencePattern}
            onChange={(pattern) => setDraft({ ...draft, recurrencePattern: pattern })}
            campaignTimezone={draft.timezone}
            segmentName={draft.segmentName ?? undefined}
            errors={recurrenceErrors}
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
        </Section>

        {/* ── Audience ── */}
        <Section title="Audience">
          <p className="text-xs text-[var(--text-3)] mb-3 inline-flex items-center gap-1.5 flex-wrap">
            <Users size={13} />
            Current segment:{" "}
            <span className="text-[var(--text-1)] font-medium">
              {draft.segmentName ? `${draft.segmentName} (#${draft.segmentId})` : `#${draft.segmentId ?? "none"}`}
            </span>
            {segmentMissing ? (
              <span className="text-amber-400 font-medium inline-flex items-center gap-1">
                <AlertTriangle size={12} /> no longer exists in Customer.io. Pick a new one below.
              </span>
            ) : (
              <span className="text-[var(--text-3)]">· pick a row below to switch</span>
            )}
          </p>
          <SegmentImporter
            singleSelectOnly
            // Always PINNED on the edit page (null cio_workspace = legacy row =
            // default brand) — passing null would flip self-serve mode on.
            workspace={campaignWs ?? DEFAULT_WS}
            onImport={(_phones, segmentId, segmentName) => {
              if (segmentId != null) {
                setDraft({ ...draft, segmentId, segmentName });
                setSegmentMissing(false);
              }
            }}
          />
        </Section>

        {/* ── Goal + dialing controls ── */}
        <Section title="Goal and dialing">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-[18px]">
            <div className="flex flex-col gap-2">
              <label htmlFor="edit-goal" className="text-xs font-medium text-[var(--text-2)] inline-flex items-center gap-1.5">
                <Target size={13} className="text-[var(--text-3)]" />
                Campaign goal (target)
              </label>
              <input
                id="edit-goal"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={draft.goalTargetText}
                onChange={(e) => setDraft({ ...draft, goalTargetText: e.target.value })}
                placeholder="e.g. 50"
                className="w-full sm:max-w-[12rem] px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
              />
            </div>

            {isRealtime && (
              <div className="flex flex-col gap-2">
                <label htmlFor="edit-cap" className="text-xs font-medium text-[var(--text-2)]">
                  Daily cap
                  <span className="text-[11px] text-[var(--text-3)] font-normal"> (max players added per day)</span>
                </label>
                <input
                  id="edit-cap"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  value={draft.dailyCapText}
                  onChange={(e) => setDraft({ ...draft, dailyCapText: e.target.value })}
                  placeholder="e.g. 150"
                  className="w-full sm:max-w-[12rem] px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
                />
              </div>
            )}

            <PillGroup
              label="Retry gap"
              options={RETRY_GAP_PRESETS.map((v) => ({ key: String(v), label: `${v} min` }))}
              activeKey={String(draft.retryGap)}
              onPick={(k) => setDraft({ ...draft, retryGap: Number(k) })}
            />
            <PillGroup
              label="Max tries per player"
              options={MAX_TRIES_PRESETS.map((v) => ({ key: String(v), label: String(v) }))}
              activeKey={String(draft.maxTries)}
              onPick={(k) => setDraft({ ...draft, maxTries: Number(k) })}
            />

            {isRealtime && (
              <div className="flex flex-col gap-2" role="group" aria-label="Call new sign-ups">
                <span className="text-xs font-medium text-[var(--text-2)]">Call new sign-ups</span>
                <div className="flex flex-wrap gap-2">
                  {CALL_DELAY_PRESETS.map((p) => (
                    <Pill
                      key={p.choice}
                      active={draft.callDelayChoice === p.choice}
                      label={p.label}
                      onClick={() => setDraft({ ...draft, callDelayChoice: p.choice })}
                    />
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
                    className="w-full sm:max-w-[12rem] px-3.5 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 transition"
                  />
                )}
                <p className="text-[11px] text-[var(--text-3)] leading-snug">
                  Applies from the next check, not tomorrow.
                </p>
              </div>
            )}
          </div>
        </Section>

        {/* ── SMS ── */}
        <Section title="Follow-up text">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="edit-sms" className="text-xs font-medium text-[var(--text-2)]">
                  Message
                  <span className="text-[11px] text-[var(--text-3)] font-normal">
                    {" "}(full text, including the link and opt-out line)
                  </span>
                </label>
                {!draft.smsTemplateUnlocked && (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          "This text includes the link and the opt-out wording. Changing it affects compliance. Continue?",
                        )
                      ) {
                        setDraft({ ...draft, smsTemplateUnlocked: true });
                      }
                    }}
                    className="text-[11px] text-blue-400 hover:text-blue-300 transition"
                  >
                    Unlock to edit
                  </button>
                )}
              </div>
              <textarea
                id="edit-sms"
                rows={3}
                value={draft.smsTemplateText}
                onChange={(e) => setDraft({ ...draft, smsTemplateText: e.target.value })}
                disabled={!draft.smsTemplateUnlocked}
                placeholder="No follow-up text set"
                className={`w-full px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 resize-none transition ${
                  !draft.smsTemplateUnlocked ? "opacity-60" : ""
                }`}
              />
            </div>

            {row.sms_consent_mode === "registered_optin" && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="edit-lr" className="text-xs font-medium text-[var(--text-2)]">
                  Last-resort text
                  <span className="text-[11px] text-[var(--text-3)] font-normal">
                    {" "}(sent after the last failed try; empty = off)
                  </span>
                </label>
                <textarea
                  id="edit-lr"
                  rows={2}
                  value={draft.lastResortText}
                  onChange={(e) => setDraft({ ...draft, lastResortText: e.target.value })}
                  placeholder="Empty = off"
                  className="w-full px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50 resize-none transition"
                />
              </div>
            )}
          </div>
        </Section>

        {/* ── Agent prompt (view only) ── */}
        <Section title="Agent prompt (view only)">
          <p className="text-[11px] text-[var(--text-3)] mb-2">
            Offer wording is compliance-owned. To change the prompt, create the next campaign with the
            approved text.
          </p>
          <textarea
            rows={6}
            value={(row.system_prompt as string) ?? ""}
            readOnly
            disabled
            aria-label="Agent system prompt, read only"
            className="w-full px-3 py-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border)] text-xs text-[var(--text-2)] opacity-70 resize-none"
          />
        </Section>

        {/* ── Save ── */}
        {saveError && <p className="text-xs text-red-400">{saveError}</p>}
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-blue-500 text-white hover:bg-blue-600 transition disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save changes
          </button>
          <Link href="/campaigns" className="text-sm text-[var(--text-3)] hover:text-[var(--text-1)] transition">
            Cancel
          </Link>
        </div>
      </div>
    </PageShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function PageShell({ children }: { children: React.ReactNode }) {
  return <div className="max-w-3xl mx-auto px-6 py-8">{children}</div>;
}

function BackLink() {
  return (
    <Link
      href="/campaigns"
      className="inline-flex items-center gap-1.5 text-sm text-[var(--text-3)] hover:text-[var(--text-1)] transition"
    >
      <ArrowLeft size={14} /> Back to campaigns
    </Link>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border-[1.5px] border-[var(--border)] bg-[var(--bg-card)] p-5">
      <h2 className="text-sm font-semibold text-[var(--text-1)] mb-4">{title}</h2>
      {children}
    </div>
  );
}

function Pill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
        active
          ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
          : "bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:border-blue-500/30 hover:text-blue-400"
      }`}
    >
      {label}
    </button>
  );
}

function PillGroup({
  label,
  options,
  activeKey,
  onPick,
}: {
  label: string;
  options: Array<{ key: string; label: string }>;
  activeKey: string;
  onPick: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2" role="group" aria-label={label}>
      <span className="text-xs font-medium text-[var(--text-2)]">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <Pill key={o.key} active={activeKey === o.key} label={o.label} onClick={() => onPick(o.key)} />
        ))}
      </div>
    </div>
  );
}
