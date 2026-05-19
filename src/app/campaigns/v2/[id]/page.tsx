"use client";

import React from "react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "next/navigation";
import { ArrowLeft, Bot, ChevronDown, Clock, Copy, MessageSquareText, Phone, Play, Pause, Plug, RefreshCw, Settings, Loader2, StopCircle, AlertTriangle, Unplug } from "lucide-react";
import { fetchCampaignV2, fetchCampaignNumbersV2, fetchCallsV2, fetchSmsMessagesV2, updateCampaignV2Status } from "@/lib/campaignV2Data";

type Row = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  // Aligned with the dashboard / campaigns list / activity badge convention:
  // bg-color/12 + border-color/30, with a small pulsing dot for `running`.
  const map: Record<string, string> = {
    draft: "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]",
    scheduled: "bg-cyan-500/12 text-cyan-400 border-cyan-500/30",
    running: "bg-emerald-500/12 text-emerald-400 border-emerald-500/30",
    paused: "bg-amber-500/12 text-amber-400 border-amber-500/30",
    // Step 1 (dashboard rebuild) added `inactive`: ejected, slot released,
    // history preserved. Distinct from `paused` (slot held); neutral
    // reflects the "resting, no slot" state.
    inactive: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
    completed: "bg-blue-500/12 text-blue-400 border-blue-500/30",
    archived: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold font-mono border ${map[status] ?? map.draft}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${status === "running" ? "animate-pulse" : ""}`} />
      {status}
    </span>
  );
}

const SMS_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  undelivered: "Undelivered",
};
const SMS_STATUS_CLS: Record<string, string> = {
  queued: "bg-gray-500/15 text-gray-400 border-gray-500/25",
  sent: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  delivered: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
  failed: "bg-red-500/15 text-red-400 border-red-500/25",
  undelivered: "bg-amber-500/15 text-amber-400 border-amber-500/25",
};

function SmsStatusCell({ sms, expanded, onToggle }: { sms: Row | undefined; expanded: boolean; onToggle: () => void }) {
  if (!sms) return <span className="text-[var(--text-3)]">—</span>;
  const status = (sms.status as string) || "queued";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border cursor-pointer hover:opacity-80 transition-opacity ${SMS_STATUS_CLS[status] ?? SMS_STATUS_CLS.queued}`}
    >
      {SMS_STATUS_LABEL[status] ?? status}
      <ChevronDown size={10} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
    </button>
  );
}

/** Inline detail row shown when an SMS badge is clicked. */
function SmsDetailRow({ sms }: { sms: Row }) {
  const status = (sms.status as string) || "queued";
  const body = (sms.body as string) || "—";
  const sentAt = sms.sent_at ? new Date(sms.sent_at as string).toLocaleString() : null;
  const createdAt = sms.created_at ? new Date(sms.created_at as string).toLocaleString() : null;
  return (
    <tr className="bg-[var(--bg-app)]">
      <td colSpan={5} className="px-5 py-3">
        <div className="flex flex-col gap-2 max-w-2xl">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--text-3)] font-semibold">
            <MessageSquareText size={10} /> SMS Details
          </div>
          <p className="text-sm text-[var(--text-2)] leading-relaxed whitespace-pre-wrap bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-2">
            {body}
          </p>
          <div className="flex gap-4 text-[10px] text-[var(--text-3)]">
            <span>Status: <span className={`font-medium ${SMS_STATUS_CLS[status]?.includes("emerald") ? "text-emerald-400" : SMS_STATUS_CLS[status]?.includes("red") ? "text-red-400" : "text-blue-400"}`}>{SMS_STATUS_LABEL[status] ?? status}</span></span>
            {sentAt && <span>Sent: {sentAt}</span>}
            {!sentAt && createdAt && <span>Queued: {createdAt}</span>}
          </div>
        </div>
      </td>
    </tr>
  );
}

// Outcome ordering, labels, and badge classes for the per-campaign breakdown row.
// Order = the natural lifecycle progression: not yet → in flight → terminal states.
const OUTCOME_DISPLAY_ORDER = [
  "pending", "in_progress", "pending_retry",
  "sent_sms", "not_interested", "declined_offer", "wrong_number",
  "unreached", "suppressed",
] as const;

const OUTCOME_LABEL: Record<string, string> = {
  pending: "Pending",
  in_progress: "In progress",
  pending_retry: "Awaiting retry",
  sent_sms: "SMS sent",
  not_interested: "Not interested",
  declined_offer: "Declined",
  wrong_number: "Wrong number",
  unreached: "Unreached",
  suppressed: "Suppressed",
};

const DAY_LABEL: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
  monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday",
  thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday",
};

const OUTCOME_BADGE_CLASS: Record<string, string> = {
  pending: "bg-[var(--bg-elevated)] text-[var(--text-2)] border border-[var(--border)]",
  in_progress: "bg-blue-500/12 text-blue-400 border border-blue-500/30",
  pending_retry: "bg-amber-500/12 text-amber-400 border border-amber-500/30",
  sent_sms: "bg-emerald-500/12 text-emerald-400 border border-emerald-500/30",
  not_interested: "bg-[var(--bg-elevated)] text-[var(--text-3)] border border-[var(--border)]",
  declined_offer: "bg-[var(--bg-elevated)] text-[var(--text-3)] border border-[var(--border)]",
  wrong_number: "bg-[var(--bg-elevated)] text-[var(--text-3)] border border-[var(--border)]",
  unreached: "bg-red-500/12 text-red-400 border border-red-500/30",
  suppressed: "bg-violet-500/12 text-violet-400 border border-violet-500/30",
};

/**
 * Format a timestamp relative to now. Past by default; pass `future: true`
 * for "in 1h 18m" style output. Returns "—" for null, "just now"/"due now"
 * for negative diffs.
 */
function formatRelative(ts: number | null, opts?: { future?: boolean }): string {
  if (!ts) return "—";
  const diff = opts?.future ? ts - Date.now() : Date.now() - ts;
  if (diff < 0) return opts?.future ? "due now" : "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s${opts?.future ? "" : " ago"}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${opts?.future ? "" : " ago"}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return `${hr}h ${remMin}m${opts?.future ? "" : " ago"}`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h${opts?.future ? "" : " ago"}`;
}

type Tab = "numbers" | "calls" | "settings";

export default function CampaignV2DetailPage() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Row | null>(null);
  const [numbers, setNumbers] = useState<Row[]>([]);
  const [calls, setCalls] = useState<Row[]>([]);
  const [smsByPhone, setSmsByPhone] = useState<Map<string, Row>>(new Map());
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("numbers");
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedSms, setExpandedSms] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopResult, setStopResult] = useState<string | null>(null);
  const cancelStopBtnRef = useRef<HTMLButtonElement>(null);
  // Step 12a (dashboard rebuild): Eject + Resume confirmation modals + results.
  // Match the Stop modal pattern for consistency — same shape, same a11y polish.
  const [confirmEject, setConfirmEject] = useState(false);
  const [ejectResult, setEjectResult] = useState<string | null>(null);
  const [rebindResult, setRebindResult] = useState<string | null>(null);
  const cancelEjectBtnRef = useRef<HTMLButtonElement>(null);
  // Step 12c: Resume-diff modal — supersedes the simple confirm Rebind modal
  // from Step 12a. Three stages: loading (GET /resume-diff), preview (skip
  // strategy radios), committing (POST /resume). Replaces confirmRebind +
  // cancelRebindBtnRef + the simple handleRebind from 12a.
  type ResumeStage = "loading" | "preview" | "committing";
  type ResumeDiff = {
    campaignId: string;
    campaignName: string;
    previousStatus: string;
    pendingCount: number;
    suppressed: { count: number; sample: string[] };
    recentlyCalled: { count: number; sample: string[] };
    outOfSegment: { count: number; sample: string[]; segmentSnapshotSize?: number; note?: string };
    segmentId: number | null;
  };
  type ResumeSkipStrategy = "skip_all" | "skip_suppressed_only";
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeStage, setResumeStage] = useState<ResumeStage>("loading");
  const [resumeDiff, setResumeDiff] = useState<ResumeDiff | null>(null);
  const [resumeSkipStrategy, setResumeSkipStrategy] = useState<ResumeSkipStrategy>("skip_all");
  const [resumeLoading, setResumeLoading] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const cancelResumeBtnRef = useRef<HTMLButtonElement>(null);
  // Step 12b-refresh: Refresh-segment modal is a two-call protocol
  // (preview → commit). The modal opens in a loading state, fires the
  // preview-only request, displays the diff, then commits on confirm.
  type RefreshPreview = {
    segmentMembersCount: number;
    existingRowsCount: number;
    toAdd: { count: number; sample: string[] };
    toRemove: { count: number; sample: string[] };
    preservedPending: { count: number };
    preservedDialed: { inSegment: number; outOfSegment: number; total: number };
  };
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreview | null>(null);
  const [refreshLoading, setRefreshLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);
  const cancelRefreshBtnRef = useRef<HTMLButtonElement>(null);
  // Step 12b-duplicate: Duplicate modal is a three-stage flow:
  //   stage='form'    — operator types new_name + toggles refresh_segment
  //   stage='preview' — POST commit=false returns diff buckets; operator
  //                     picks a skip strategy radio
  //   stage='committing' — POST commit=true with skip choices; on success
  //                        navigate to the new campaign's detail page
  // Override pickers for base/voice/prompt are NOT included in Phase 1 —
  // operator edits the new campaign after creation if those need to change.
  type DuplicateStage = "form" | "preview" | "committing";
  type DuplicatePreview = {
    candidateSource: string;
    candidatesCount: number;
    overlap: { count: number; sample: string[] };
    suppressed: { count: number; sample: string[] };
    recentlyCalled: { count: number; sample: string[] };
  };
  type SkipStrategy = "overlap_only" | "overlap_and_recent" | "keep_all";
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateStage, setDuplicateStage] = useState<DuplicateStage>("form");
  const [duplicateName, setDuplicateName] = useState("");
  const [duplicateRefreshSegment, setDuplicateRefreshSegment] = useState(true);
  const [duplicateSkipStrategy, setDuplicateSkipStrategy] = useState<SkipStrategy>("overlap_only");
  const [duplicatePreview, setDuplicatePreview] = useState<DuplicatePreview | null>(null);
  const [duplicateLoading, setDuplicateLoading] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const cancelDuplicateBtnRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();

  // Modal a11y polish (2026-05-11): when the Emergency Stop modal opens,
  // auto-focus the safer Cancel button (so an accidental Enter doesn't
  // confirm the destructive action) and let Escape dismiss it.
  useEffect(() => {
    if (!confirmStop) return;
    cancelStopBtnRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !acting) setConfirmStop(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [confirmStop, acting]);

  // Same a11y treatment for Eject + Rebind modals.
  useEffect(() => {
    if (!confirmEject) return;
    cancelEjectBtnRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !acting) setConfirmEject(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [confirmEject, acting]);

  // Resume-diff modal a11y — Step 12c. Same auto-focus-Cancel + Escape-closes
  // pattern. Escape NO-OP during the 'committing' stage (POST /resume is
  // mid-flight, may have already created the new clone + lease).
  useEffect(() => {
    if (!resumeOpen) return;
    cancelResumeBtnRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && resumeStage !== "committing") {
        setResumeOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [resumeOpen, resumeStage]);

  // Refresh-segment modal a11y. The Cancel button is safe (read-only preview
  // doesn't change DB state until Refresh is clicked), but auto-focusing it
  // keeps the muscle-memory consistent across all modals.
  useEffect(() => {
    if (!refreshOpen) return;
    cancelRefreshBtnRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !refreshLoading) {
        setRefreshOpen(false);
        setRefreshPreview(null);
        setRefreshError(null);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [refreshOpen, refreshLoading]);

  // Duplicate modal a11y — same pattern. Escape only closes when not in the
  // committing stage (post-confirm, post-Vapi-clone-creation is irreversible).
  useEffect(() => {
    if (!duplicateOpen) return;
    cancelDuplicateBtnRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && duplicateStage !== "committing") {
        setDuplicateOpen(false);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [duplicateOpen, duplicateStage]);

  // Seed the duplicate-name field with "<source> (YYYY-MM-DD)" when opening
  // the modal. Operator can edit; required to be non-empty before Save.
  function openDuplicateModal() {
    const today = new Date().toISOString().slice(0, 10);
    const sourceName = (campaign?.name as string) ?? "Campaign";
    setDuplicateName(`${sourceName} (${today})`);
    setDuplicateRefreshSegment(true);
    setDuplicateSkipStrategy("overlap_only");
    setDuplicatePreview(null);
    setDuplicateError(null);
    setDuplicateStage("form");
    setDuplicateOpen(true);
  }

  // Fetch all campaign data — used on mount and by polling.
  // Wrapped in useCallback so the interval always calls the latest version
  // and ESLint exhaustive-deps stays clean.
  const refreshData = useCallback(async () => {
    if (!id) return;
    try {
      const [c, n, cl, sms] = await Promise.all([
        fetchCampaignV2(id),
        fetchCampaignNumbersV2(id),
        fetchCallsV2(id).catch(() => []),
        fetchSmsMessagesV2(id).catch(() => []),
      ]);
      setCampaign(c);
      setNumbers(n);
      setCalls(cl);
      const map = new Map<string, Row>();
      for (const row of sms) {
        const phone = row.to_phone_e164 as string | undefined;
        if (phone && !map.has(phone)) map.set(phone, row);
      }
      setSmsByPhone(map);
    } catch (err) {
      console.error("Failed to load campaign:", err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  // Initial fetch
  useEffect(() => {
    refreshData();
  }, [refreshData]);

  // Auto-refresh while campaign is in any non-terminal state so transitions
  // (running → paused, draft → running, etc.) are visible without a manual
  // refresh. 5s when actively dialling, 15s while waiting/recovering.
  // Stops on completed/archived. Drafts with no start_at don't transition
  // autonomously, so they're skipped too. Polls only when the tab is visible
  // and skips overlapping requests during latency spikes.
  const pollInFlightRef = useRef(false);
  useEffect(() => {
    const status = campaign?.status as string | undefined;
    const startAt = campaign?.start_at as string | null | undefined;
    if (!status || status === "completed" || status === "archived") return;
    if (status === "draft" && !startAt) return;
    const intervalMs = status === "running" ? 5000 : 15000;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      try {
        await refreshData();
      } finally {
        pollInFlightRef.current = false;
      }
    };
    const interval = setInterval(tick, intervalMs);
    return () => clearInterval(interval);
  }, [campaign?.status, campaign?.start_at, refreshData]);

  // Derived live stats for the header line: when did we start, how long
  // since last call, when's the next retry due, total calls fired, calls
  // currently in flight. Recomputes when calls/numbers state updates
  // (i.e., on every successful poll).
  const liveStats = useMemo(() => {
    const inFlightStatuses = new Set(["initiated", "ringing", "in_progress", "answered"]);
    let firstCallAt: number | null = null;
    let lastCallEndedAt: number | null = null;
    let inFlightCount = 0;

    for (const c of calls) {
      const created = c.created_at ? new Date(c.created_at as string).getTime() : 0;
      if (created > 0 && (firstCallAt === null || created < firstCallAt)) firstCallAt = created;

      if (inFlightStatuses.has(c.status as string)) {
        inFlightCount++;
      } else if (c.ended_at) {
        const ended = new Date(c.ended_at as string).getTime();
        if (lastCallEndedAt === null || ended > lastCallEndedAt) lastCallEndedAt = ended;
      }
    }

    let nextRetryAt: number | null = null;
    for (const n of numbers) {
      if (n.outcome === "pending_retry" && n.next_attempt_at) {
        const t = new Date(n.next_attempt_at as string).getTime();
        if (t > Date.now() && (nextRetryAt === null || t < nextRetryAt)) nextRetryAt = t;
      }
    }

    return { firstCallAt, lastCallEndedAt, inFlightCount, nextRetryAt, callsFired: calls.length };
  }, [calls, numbers]);

  // Per-outcome counts for the breakdown badge row above the numbers table.
  const outcomeBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of numbers) {
      const o = (n.outcome as string) || "pending";
      counts[o] = (counts[o] ?? 0) + 1;
    }
    return counts;
  }, [numbers]);

  async function handleStart() {
    if (!id) return;
    setActing(true);
    setActionError(null);

    // Optimistic update: flip the badge to `running` immediately so the UI
    // reflects the intent while the server-side fireCall blocks on the
    // FreeSWITCH bgapi (8-22s per memory project_freeswitch_bgapi_slow).
    // Without this, the dashboard appears frozen for the full bgapi window
    // even though the customer's phone is already ringing. We snapshot the
    // previous status so we can revert cleanly if the server rejects.
    const prevStatus = campaign?.status as string | undefined;
    setCampaign((prev) => (prev ? { ...prev, status: "running" } : prev));

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/start`, { method: "POST" });
      if (!res.ok) {
        // Revert optimistic update so the badge reflects reality (queue gate
        // hit, schedule guard, outside call window, etc.).
        setCampaign((prev) =>
          prev && prevStatus ? { ...prev, status: prevStatus } : prev,
        );
        const body = await res.json().catch(() => ({}));
        setActionError(
          typeof body.error === "string"
            ? body.error
            : `Failed to start campaign (${res.status}).`,
        );
        return;
      }
      // Server accepted. Pull the fresh campaign + calls + numbers state so
      // the live status line ("Started just now · Live call") populates
      // immediately without waiting for the next 5s polling tick.
      await refreshData();
    } catch (err) {
      // Network error → revert optimistic update too
      setCampaign((prev) =>
        prev && prevStatus ? { ...prev, status: prevStatus } : prev,
      );
      console.error("Start failed:", err);
      setActionError(err instanceof Error ? err.message : "Failed to start campaign.");
    } finally {
      setActing(false);
    }
  }

  async function handlePause() {
    if (!id) return;
    setActing(true);
    try {
      const updated = await updateCampaignV2Status(id, "paused");
      setCampaign(updated);
    } catch (err) {
      console.error("Pause failed:", err);
    } finally {
      setActing(false);
    }
  }

  // Emergency Stop ("kill switch"): differs from Pause in that it ALSO
  // attempts to terminate any in-flight Vapi call immediately (not just
  // stop new dials). Pending_retry rows on other numbers stay queued for
  // resume. Backend at /api/campaigns-v2/[id]/stop handles the atomic flip
  // + best-effort Vapi DELETE. UI follows handleStart's optimistic pattern.
  async function handleStop() {
    if (!id) return;
    setConfirmStop(false);
    setActing(true);
    setActionError(null);
    setStopResult(null);

    const prevStatus = campaign?.status as string | undefined;
    // Optimistic: flip badge to paused immediately so UI feels responsive
    setCampaign((prev) => (prev ? { ...prev, status: "paused" } : prev));

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/stop`, { method: "POST" });
      if (!res.ok) {
        // Revert optimistic update if backend rejected
        setCampaign((prev) =>
          prev && prevStatus ? { ...prev, status: prevStatus } : prev,
        );
        const body = await res.json().catch(() => ({}));
        setActionError(
          typeof body.error === "string"
            ? body.error
            : `Failed to stop campaign (${res.status}).`,
        );
        return;
      }
      const body = await res.json().catch(() => ({}));
      const inFlight = body?.inFlightCount ?? 0;
      // Honest copy: we stopped the queue, but in-flight calls end naturally.
      // Don't promise "terminated" when the live audio session is still
      // unwinding for ~60s. (Phase 1 follow-up will wire actual termination.)
      setStopResult(
        inFlight > 0
          ? `Stopped queueing new calls. ${inFlight} call${inFlight !== 1 ? "s" : ""} currently in progress will end naturally within ~60 seconds.`
          : "Stopped queueing new calls. No calls were in flight.",
      );
      await refreshData();
    } catch (err) {
      setCampaign((prev) =>
        prev && prevStatus ? { ...prev, status: prevStatus } : prev,
      );
      console.error("Stop failed:", err);
      setActionError(err instanceof Error ? err.message : "Failed to stop campaign.");
    } finally {
      setActing(false);
    }
  }

  // ── Step 12a: Eject + Resume (Rebind) handlers ──
  // Both follow the handleStop optimistic-update pattern: flip the status
  // optimistically, POST to the endpoint, revert on error, refresh on success.
  // Wired to Step 3 (eject) + Step 4b (rebind) endpoints.
  async function handleEject() {
    if (!id) return;
    setConfirmEject(false);
    setActing(true);
    setActionError(null);
    setEjectResult(null);
    setRebindResult(null);

    const prevStatus = campaign?.status as string | undefined;
    // Optimistic: flip to inactive (slot released, history preserved)
    setCampaign((prev) => (prev ? { ...prev, status: "inactive" } : prev));

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/eject`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCampaign((prev) =>
          prev && prevStatus ? { ...prev, status: prevStatus } : prev,
        );
        setActionError(
          typeof body.error === "string"
            ? body.error
            : `Failed to eject worker (${res.status}).`,
        );
        return;
      }
      const slotLabel = typeof body.slotReleased === "string" ? body.slotReleased : null;
      const warnings = Array.isArray(body.vapiWarnings) ? body.vapiWarnings : [];
      setEjectResult(
        slotLabel
          ? `Ejected. ${slotLabel} released, clone deleted. Campaign history preserved.${
              warnings.length ? ` (${warnings.length} Vapi warning${warnings.length !== 1 ? "s" : ""})` : ""
            }`
          : "Ejected. Campaign history preserved.",
      );
      await refreshData();
    } catch (err) {
      setCampaign((prev) =>
        prev && prevStatus ? { ...prev, status: prevStatus } : prev,
      );
      console.error("Eject failed:", err);
      setActionError(err instanceof Error ? err.message : "Failed to eject worker.");
    } finally {
      setActing(false);
    }
  }

  // ── Step 12c: Resume-diff two-stage flow ──
  // Replaces the simple confirm Rebind from Step 12a. The modal opens in a
  // loading state, GETs /resume-diff to compute the three buckets, advances
  // to preview with skip-strategy radios, and POSTs /resume on confirm.
  // POST /resume internally branches: paused → simple flip; inactive →
  // executeRebindCore (re-clone + slot lease + status flip). The page
  // receives a uniform response either way.
  async function openResumeModal() {
    if (!id) return;
    setResumeOpen(true);
    setResumeStage("loading");
    setResumeDiff(null);
    setResumeError(null);
    setResumeSkipStrategy("skip_all");
    setResumeLoading(true);

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/resume-diff`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResumeError(
          typeof body.error === "string"
            ? body.error
            : `Failed to compute resume diff (${res.status}).`,
        );
        return;
      }
      setResumeDiff(body as ResumeDiff);
      setResumeStage("preview");
    } catch (err) {
      console.error("Resume-diff fetch failed:", err);
      setResumeError(err instanceof Error ? err.message : "Failed to compute resume diff.");
    } finally {
      setResumeLoading(false);
    }
  }

  async function handleResumeCommit() {
    if (!id || !resumeDiff) return;
    setResumeError(null);
    setResumeStage("committing");
    setResumeLoading(true);
    setActionError(null);
    setEjectResult(null);
    setRebindResult(null);

    const prevStatus = campaign?.status as string | undefined;
    // Optimistic: flip to running. Resume from paused or inactive both end
    // at status='running'; if it fails, revert.
    setCampaign((prev) => (prev ? { ...prev, status: "running" } : prev));

    // Map radio to skip flags. Suppression is always skipped (informational
    // bucket; dialer.ts:121-156 also skips at dial time). The radio only
    // chooses between "skip_all 3 buckets" vs "skip suppressed only" per
    // design doc section 5.7.
    const skipRecentlyCalled = resumeSkipStrategy === "skip_all";
    const skipOutOfSegment = resumeSkipStrategy === "skip_all" && resumeDiff.segmentId != null;

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skip_suppressed: true,
          skip_recently_called: skipRecentlyCalled,
          skip_out_of_segment: skipOutOfSegment,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCampaign((prev) =>
          prev && prevStatus ? { ...prev, status: prevStatus } : prev,
        );
        setResumeError(
          typeof body.error === "string"
            ? body.error
            : `Failed to resume (${res.status}).`,
        );
        setResumeStage("preview");
        return;
      }
      const slotLabel = typeof body.slotLabel === "string" ? body.slotLabel : null;
      const softMarked = body.softMarked || {};
      const softMarkedRecent = typeof softMarked.recentlyCalled === "number" ? softMarked.recentlyCalled : 0;
      const softMarkedOOS = typeof softMarked.outOfSegment === "number" ? softMarked.outOfSegment : 0;
      const totalSoftMarked = softMarkedRecent + softMarkedOOS;
      const parts: string[] = [];
      if (slotLabel) parts.push(`${slotLabel} leased`);
      if (totalSoftMarked > 0) parts.push(`${totalSoftMarked} number${totalSoftMarked !== 1 ? "s" : ""} soft-marked`);
      setRebindResult(
        parts.length > 0 ? `Resumed. ${parts.join(", ")}.` : "Resumed.",
      );
      setResumeOpen(false);
      await refreshData();
    } catch (err) {
      setCampaign((prev) =>
        prev && prevStatus ? { ...prev, status: prevStatus } : prev,
      );
      console.error("Resume commit failed:", err);
      setResumeError(err instanceof Error ? err.message : "Failed to resume.");
      setResumeStage("preview");
    } finally {
      setResumeLoading(false);
    }
  }

  // ── Step 12b-refresh: Refresh-segment two-call flow ──
  // Opening the modal fires the preview-only request (commit=false); the
  // operator sees the 4-bucket diff and confirms or cancels. Commit fires
  // a second POST (commit=true) that applies the INSERT + UPDATE.
  async function openRefreshModal() {
    if (!id) return;
    setRefreshOpen(true);
    setRefreshPreview(null);
    setRefreshError(null);
    setRefreshLoading(true);

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/refresh-segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: false }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefreshError(
          typeof body.error === "string"
            ? body.error
            : `Failed to fetch segment preview (${res.status}).`,
        );
        return;
      }
      // Defensive: the endpoint returns a slightly-different success shape
      // depending on whether segment_id is null, but for the campaigns this
      // button is enabled on (segment_id non-null), all the expected fields
      // are present.
      setRefreshPreview(body as RefreshPreview);
    } catch (err) {
      console.error("Refresh preview failed:", err);
      setRefreshError(err instanceof Error ? err.message : "Failed to fetch segment preview.");
    } finally {
      setRefreshLoading(false);
    }
  }

  // ── Step 12b-duplicate: form → preview → commit handlers ──
  async function handleDuplicatePreview() {
    if (!id) return;
    const name = duplicateName.trim();
    if (!name) {
      setDuplicateError("Name is required.");
      return;
    }
    setDuplicateError(null);
    setDuplicateLoading(true);

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_name: name,
          refresh_segment: duplicateRefreshSegment,
          commit: false,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDuplicateError(
          typeof body.error === "string"
            ? body.error
            : `Failed to fetch duplicate preview (${res.status}).`,
        );
        return;
      }
      setDuplicatePreview(body as DuplicatePreview);
      setDuplicateStage("preview");
    } catch (err) {
      console.error("Duplicate preview failed:", err);
      setDuplicateError(err instanceof Error ? err.message : "Failed to fetch duplicate preview.");
    } finally {
      setDuplicateLoading(false);
    }
  }

  async function handleDuplicateCommit() {
    if (!id || !duplicatePreview) return;
    const name = duplicateName.trim();
    if (!name) return;
    setDuplicateLoading(true);
    setDuplicateError(null);
    setDuplicateStage("committing");

    // Map the operator's radio choice to skip flags. Suppression is always
    // skipped (informational bucket; never an operator-toggleable option).
    const skipOverlap = duplicateSkipStrategy !== "keep_all";
    const skipRecentlyCalled = duplicateSkipStrategy === "overlap_and_recent";

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          new_name: name,
          refresh_segment: duplicateRefreshSegment,
          commit: true,
          skip_overlap: skipOverlap,
          skip_suppressed: true,
          skip_recently_called: skipRecentlyCalled,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setDuplicateError(
          typeof body.error === "string"
            ? body.error
            : `Failed to create duplicate (${res.status}).`,
        );
        setDuplicateStage("preview");
        return;
      }
      const newId = typeof body.newCampaignId === "string" ? body.newCampaignId : null;
      if (!newId) {
        setDuplicateError("Server did not return a new campaign id.");
        setDuplicateStage("preview");
        return;
      }
      setDuplicateOpen(false);
      // Navigate to the new campaign's detail page so the operator lands in
      // the right place to review numbers + press Start when ready.
      router.push(`/campaigns/v2/${newId}`);
    } catch (err) {
      console.error("Duplicate commit failed:", err);
      setDuplicateError(err instanceof Error ? err.message : "Failed to create duplicate.");
      setDuplicateStage("preview");
    } finally {
      setDuplicateLoading(false);
    }
  }

  async function handleRefreshCommit() {
    if (!id || !refreshPreview) return;
    setRefreshLoading(true);
    setRefreshError(null);

    try {
      const res = await fetch(`/api/campaigns-v2/${id}/refresh-segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRefreshError(
          typeof body.error === "string"
            ? body.error
            : `Failed to apply refresh (${res.status}).`,
        );
        return;
      }
      const inserted = typeof body.insertedCount === "number" ? body.insertedCount : 0;
      const softMarked = typeof body.softMarkedCount === "number" ? body.softMarkedCount : 0;
      const parts: string[] = [];
      if (inserted > 0) parts.push(`${inserted} new number${inserted !== 1 ? "s" : ""} added`);
      if (softMarked > 0) parts.push(`${softMarked} pending number${softMarked !== 1 ? "s" : ""} removed from segment`);
      if (parts.length === 0) parts.push("no changes applied");
      setRefreshResult(`Segment refreshed: ${parts.join(", ")}.`);
      setRefreshOpen(false);
      setRefreshPreview(null);
      await refreshData();
    } catch (err) {
      console.error("Refresh commit failed:", err);
      setRefreshError(err instanceof Error ? err.message : "Failed to apply refresh.");
    } finally {
      setRefreshLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto flex items-center justify-center py-24 text-[var(--text-3)]">
        <Loader2 size={20} className="animate-spin mr-2" /> Loading...
      </div>
    );
  }

  if (!campaign) {
    return (
      <div className="p-4 sm:p-6 max-w-6xl mx-auto text-center py-24 text-[var(--text-3)]">
        Campaign not found.
      </div>
    );
  }

  const status = campaign.status as string;
  const isScheduled = status === "draft" && !!campaign.start_at && new Date(campaign.start_at as string).getTime() > Date.now();
  const phoneByNumberId = new Map(
    numbers.map((n) => [n.id as string, n.phone_e164 as string]),
  );

  const tabClass = (t: Tab) =>
    `px-4 py-2 text-sm font-medium rounded-xl transition-colors ${
      tab === t
        ? "bg-blue-600 text-white"
        : "text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
    }`;

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
      {/* Header */}
      <div className="mb-6">
        <Link href="/campaigns" className="inline-flex items-center gap-1.5 text-sm text-[var(--text-2)] hover:text-blue-400 transition-colors mb-3">
          <ArrowLeft size={14} /> Back to Campaigns
        </Link>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
              <Bot size={18} className="text-blue-400" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-[var(--text-1)] truncate">{campaign.name as string}</h1>
                <StatusBadge status={isScheduled ? "scheduled" : status} />
              </div>
              <p className="text-sm text-[var(--text-3)] mt-1">
                {(() => {
                  const raw = (campaign.vapi_assistant_name as string) || "";
                  const display = raw.replace(/\s*\([^)]*\)?\s*$/, "").trim();
                  return display ? `${display} · ${campaign.timezone}` : (campaign.timezone as string);
                })()}
              </p>
              {(liveStats.firstCallAt || liveStats.callsFired > 0) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-3)] mt-1.5">
                  {liveStats.firstCallAt && (
                    <span>Started {formatRelative(liveStats.firstCallAt)}</span>
                  )}
                  {/* Live operational indicators (Live call / Idle / Next retry) only
                      apply while the campaign is `running` — for completed/paused/
                      archived they're misleading. The status badge above already
                      conveys the non-running state; pure historical facts (Started,
                      N calls fired) stay visible always. */}
                  {status === "running" && liveStats.inFlightCount > 0 ? (
                    <span className="inline-flex items-center gap-1 text-emerald-400 font-medium">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Live call
                    </span>
                  ) : status === "running" && liveStats.lastCallEndedAt ? (
                    <span>Idle {formatRelative(liveStats.lastCallEndedAt)}</span>
                  ) : null}
                  {status === "running" && liveStats.nextRetryAt && (
                    <span>Next retry in {formatRelative(liveStats.nextRetryAt, { future: true })}</span>
                  )}
                  {liveStats.callsFired > 0 && (
                    <span>
                      {liveStats.callsFired} call{liveStats.callsFired !== 1 ? "s" : ""} fired
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(status === "draft" || status === "paused") && !isScheduled && (
              <button
                onClick={handleStart}
                disabled={acting}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
              >
                <Play size={15} /> Start
              </button>
            )}
            {status === "running" && (
              <>
                <button
                  onClick={handlePause}
                  disabled={acting}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-yellow-600 hover:bg-yellow-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
                >
                  <Pause size={15} /> Pause
                </button>
                {/* Thin divider — visually separates the soft action (Pause)
                    from the destructive emergency action (Stop). Helps prevent
                    misclicks in a panic moment. */}
                <span aria-hidden className="w-px h-6 bg-[var(--border)]" />
                <button
                  onClick={() => setConfirmStop(true)}
                  disabled={acting}
                  title="Emergency stop — stops queueing new calls; any in-flight call ends naturally within ~60s"
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
                >
                  <StopCircle size={15} /> Stop
                </button>
              </>
            )}
            {/* Eject — release the SIP slot + delete clone; preserve campaign +
                history. Allowed on draft/paused/completed/archived per Step 3
                spec (task tracker §3). Amber accent: release, not destroy. */}
            {(status === "draft" || status === "paused" || status === "completed" || status === "archived") && (
              <button
                onClick={() => setConfirmEject(true)}
                disabled={acting}
                title="Eject worker — releases the SIP slot and deletes the Vapi clone; campaign and history preserved"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
              >
                <Unplug size={15} /> Eject
              </button>
            )}
            {/* Resume — re-clone the base assistant + lease a fresh slot + flip
                back to running. Step 4b rebind endpoint. Shown only on
                inactive (ejected) campaigns. */}
            {/* Resume — Step 12c upgrades the Step 12a simple confirm into a
                three-bucket diff modal. Shown only on inactive campaigns
                (paused campaigns use the existing Start button for the
                simple flip path; if operators want the diff check for
                paused, that's a Phase 2 UX decision). */}
            {status === "inactive" && (
              <button
                onClick={openResumeModal}
                disabled={acting}
                title="Resume — review the three-bucket diff (suppression, recent, segment) before re-leasing a worker"
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
              >
                <Plug size={15} /> Resume
              </button>
            )}
            {/* Refresh segment — Step 6 endpoint, two-call protocol. Always
                rendered per design doc §5.5; disabled with hover hint when
                running (allowed states per task tracker §6 are
                draft/paused/inactive/completed/archived) or when the campaign
                has no source segment to refresh from. */}
            {(() => {
              const cannotRunning = status === "running";
              const cannotNoSegment = campaign.segment_id == null;
              const disabled = acting || cannotRunning || cannotNoSegment;
              const title = cannotRunning
                ? "Pause the campaign first"
                : cannotNoSegment
                  ? "No source segment to refresh from"
                  : "Refresh segment — pull current customer.io members and apply a non-destructive diff";
              return (
                <button
                  onClick={openRefreshModal}
                  disabled={disabled}
                  title={title}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  <RefreshCw size={15} /> Refresh segment
                </button>
              );
            })()}
            {/* Duplicate — Step 5b endpoint, three-stage modal (form →
                preview → commit). Always rendered per task tracker §5
                (any source status is duplicable, except 'recurring' which
                the backend rejects with 400; the button surfaces that
                rejection cleanly as an inline error). */}
            <button
              onClick={openDuplicateModal}
              disabled={acting}
              title="Duplicate this campaign with an optional fresh segment fetch + diff preview"
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-70 text-white text-sm font-medium transition-colors"
            >
              <Copy size={15} /> Duplicate
            </button>
          </div>
        </div>
      </div>

      {isScheduled && (
        <p className="mb-4 text-sm text-emerald-400">
          Starts {new Date(campaign.start_at as string).toLocaleString()}
        </p>
      )}

      {actionError && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {stopResult && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-300 flex items-center justify-between gap-3">
          <span>{stopResult}</span>
          <button
            onClick={() => setStopResult(null)}
            className="text-emerald-300/70 hover:text-emerald-200 text-xs"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {ejectResult && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-200 flex items-center justify-between gap-3">
          <span>{ejectResult}</span>
          <button
            onClick={() => setEjectResult(null)}
            className="text-amber-300/70 hover:text-amber-200 text-xs"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {rebindResult && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-sm text-emerald-300 flex items-center justify-between gap-3">
          <span>{rebindResult}</span>
          <button
            onClick={() => setRebindResult(null)}
            className="text-emerald-300/70 hover:text-emerald-200 text-xs"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {refreshResult && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-sky-500/30 bg-sky-500/10 text-sm text-sky-300 flex items-center justify-between gap-3">
          <span>{refreshResult}</span>
          <button
            onClick={() => setRefreshResult(null)}
            className="text-sky-300/70 hover:text-sky-200 text-xs"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Emergency Stop confirmation modal */}
      {confirmStop && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-stop-title"
          onClick={() => !acting && setConfirmStop(false)}
        >
          <div
            className="bg-[var(--bg-card)] border border-red-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle size={18} className="text-red-400" />
              </div>
              <h3 id="confirm-stop-title" className="text-base font-semibold text-[var(--text-1)]">
                Emergency Stop?
              </h3>
            </div>
            <p className="text-sm text-[var(--text-2)] mb-2 leading-relaxed">
              This will <span className="font-semibold text-red-400">stop queueing new calls</span> and
              pause the campaign immediately. Any call <em>currently in progress</em> will end
              naturally within ~60 seconds (queue gate caps in-flight calls at one).
            </p>
            <p className="text-xs text-[var(--text-3)] mb-5 leading-relaxed">
              Numbers scheduled for retry stay queued — resume later with Start, or delete the
              campaign after pausing to discard everything.
            </p>
            <div className="flex justify-end gap-2">
              <button
                ref={cancelStopBtnRef}
                onClick={() => setConfirmStop(false)}
                disabled={acting}
                className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
              >
                Cancel
              </button>
              <button
                onClick={handleStop}
                disabled={acting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-70 text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-red-400"
              >
                <StopCircle size={14} />
                {acting ? "Stopping..." : "Stop Campaign"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Eject confirmation modal — Step 12a (dashboard rebuild) */}
      {confirmEject && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-eject-title"
          onClick={() => !acting && setConfirmEject(false)}
        >
          <div
            className="bg-[var(--bg-card)] border border-amber-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                <Unplug size={18} className="text-amber-400" />
              </div>
              <h3 id="confirm-eject-title" className="text-base font-semibold text-[var(--text-1)]">
                Eject worker from &quot;{campaign.name as string}&quot;?
              </h3>
            </div>
            <p className="text-sm text-[var(--text-2)] mb-2 leading-relaxed">
              This will <span className="font-semibold text-amber-300">release the SIP slot</span> for
              another campaign and delete the cloned agent on Vapi.
            </p>
            <p className="text-xs text-[var(--text-3)] mb-5 leading-relaxed">
              Campaign history ({numbers.length} number{numbers.length !== 1 ? "s" : ""},{" "}
              {calls.length} call{calls.length !== 1 ? "s" : ""}) is preserved. You can re-assign a
              worker later via Resume.
            </p>
            <div className="flex justify-end gap-2">
              <button
                ref={cancelEjectBtnRef}
                onClick={() => setConfirmEject(false)}
                disabled={acting}
                className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
              >
                Cancel
              </button>
              <button
                onClick={handleEject}
                disabled={acting}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-70 text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400"
              >
                <Unplug size={14} />
                {acting ? "Ejecting..." : "Eject"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resume-diff modal — Step 12c (replaces the simple confirm from 12a).
          Three-stage: loading (GET /resume-diff in flight), preview (3-bucket
          diff + skip strategy radios), committing (POST /resume in flight). */}
      {resumeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="resume-diff-title"
          onClick={() => {
            if (resumeStage === "committing") return;
            setResumeOpen(false);
          }}
        >
          <div
            className="bg-[var(--bg-card)] border border-emerald-500/30 rounded-2xl shadow-2xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                <Plug size={18} className="text-emerald-400" />
              </div>
              <h3 id="resume-diff-title" className="text-base font-semibold text-[var(--text-1)]">
                Resume &quot;{campaign.name as string}&quot;?
              </h3>
            </div>

            {/* ── Stage: loading ── */}
            {resumeStage === "loading" && (
              <div className="py-6 flex flex-col items-center gap-3">
                <Loader2 size={28} className="text-emerald-400 animate-spin" />
                <p className="text-sm text-[var(--text-2)]">Cross-checking against current state...</p>
                <p className="text-[10px] text-[var(--text-3)]">
                  Suppression list · cross-campaign 7-day calls · segment membership
                  {resumeError && <span className="block mt-2 text-red-300">{resumeError}</span>}
                </p>
              </div>
            )}

            {/* ── Stage: preview ── */}
            {resumeStage === "preview" && resumeDiff && (
              <>
                {/* Pre-Step-2 legacy campaign: base_assistant_id null guard.
                    The endpoint succeeds for diff computation but POST /resume
                    will fail when status='inactive' AND base_assistant_id null.
                    Surface this BEFORE the operator commits. */}
                {resumeDiff.previousStatus === "inactive" && !campaign.base_assistant_id ? (
                  <>
                    <p className="text-sm text-amber-300 mb-4 leading-relaxed">
                      This campaign was created before resume support landed. Pick a base agent on
                      the campaign detail page first, then try Resume again.
                    </p>
                    <div className="flex justify-end">
                      <button
                        ref={cancelResumeBtnRef}
                        onClick={() => setResumeOpen(false)}
                        className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
                      >
                        Close
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-[var(--text-3)] mb-3 leading-relaxed">
                      {resumeDiff.pendingCount} pending number{resumeDiff.pendingCount !== 1 ? "s" : ""}. Cross-checking against current state:
                    </p>
                    <div className="mb-4 space-y-1.5 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--text-2)]">In your suppression list</span>
                        <span className="font-semibold text-red-300">{resumeDiff.suppressed.count}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--text-2)]">Called by another campaign (7d)</span>
                        <span className="font-semibold text-orange-300">{resumeDiff.recentlyCalled.count}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[var(--text-2)]">
                          No longer in segment
                          {resumeDiff.outOfSegment.note && <span className="ml-1 text-[10px] text-[var(--text-3)]">({resumeDiff.outOfSegment.note})</span>}
                        </span>
                        <span className="font-semibold text-amber-300">{resumeDiff.outOfSegment.count}</span>
                      </div>
                    </div>

                    <fieldset className="mb-4">
                      <legend className="text-xs uppercase tracking-wide text-[var(--text-3)] mb-2 font-semibold">
                        Skip strategy
                      </legend>
                      <div className="space-y-2">
                        {(() => {
                          const allSkipped =
                            resumeDiff.suppressed.count +
                            resumeDiff.recentlyCalled.count +
                            resumeDiff.outOfSegment.count;
                          // Suppression auto-skips at dial time; the only operator-toggleable
                          // groups are recently_called and out_of_segment. Net dialable:
                          //   skip_all              = pendingCount - all 3 buckets
                          //   skip_suppressed_only  = pendingCount - suppressed
                          //   (the diagram counts may double-count phones in multiple buckets;
                          //   these are upper-bound estimates for operator decision-making.)
                          const dialSkipAll = Math.max(0, resumeDiff.pendingCount - allSkipped);
                          const dialSkipSuppressedOnly = Math.max(0, resumeDiff.pendingCount - resumeDiff.suppressed.count);
                          return ([
                            {
                              value: "skip_all" as const,
                              label: "Skip all three buckets",
                              hint: `Dial ${dialSkipAll}`,
                              warning: false,
                            },
                            {
                              value: "skip_suppressed_only" as const,
                              label: "Skip suppressed only",
                              hint: `Dial ${dialSkipSuppressedOnly} (risks double-dial)`,
                              warning: true,
                            },
                          ]).map((opt) => (
                            <label
                              key={opt.value}
                              className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                                resumeSkipStrategy === opt.value
                                  ? "border-emerald-500/50 bg-emerald-500/10"
                                  : "border-[var(--border)] bg-[var(--bg-app)] hover:border-[var(--text-3)]"
                              }`}
                            >
                              <input
                                type="radio"
                                name="resume-skip-strategy"
                                value={opt.value}
                                checked={resumeSkipStrategy === opt.value}
                                onChange={() => setResumeSkipStrategy(opt.value as ResumeSkipStrategy)}
                                className="mt-0.5 h-4 w-4"
                              />
                              <div className="flex-1">
                                <p className="text-sm text-[var(--text-1)]">{opt.label}</p>
                                <p className={`text-[10px] ${opt.warning ? "text-amber-300" : "text-[var(--text-3)]"}`}>
                                  {opt.hint}
                                </p>
                              </div>
                            </label>
                          ));
                        })()}
                      </div>
                    </fieldset>

                    {resumeError && (
                      <div className="mb-4 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                        {resumeError}
                      </div>
                    )}

                    <div className="flex justify-end gap-2">
                      <button
                        ref={cancelResumeBtnRef}
                        onClick={() => setResumeOpen(false)}
                        disabled={resumeLoading}
                        className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleResumeCommit}
                        disabled={resumeLoading}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-70 text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-400"
                      >
                        <Plug size={14} />
                        Resume
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ── Stage: committing ── */}
            {resumeStage === "committing" && (
              <div className="py-6 flex flex-col items-center gap-3">
                <Loader2 size={28} className="text-emerald-400 animate-spin" />
                <p className="text-sm text-[var(--text-2)]">Resuming campaign...</p>
                <p className="text-[10px] text-[var(--text-3)]">
                  {campaign.status === "inactive"
                    ? "Cloning base agent + leasing worker slot."
                    : "Unpausing the queue."}
                </p>
              </div>
            )}

            {/* Error state (when loading failed entirely) */}
            {resumeStage === "loading" && resumeError && (
              <div className="mt-3 flex justify-end">
                <button
                  ref={cancelResumeBtnRef}
                  onClick={() => setResumeOpen(false)}
                  className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Duplicate modal — Step 12b-duplicate, three-stage flow */}
      {duplicateOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-duplicate-title"
          onClick={() => {
            if (duplicateStage === "committing") return;
            setDuplicateOpen(false);
          }}
        >
          <div
            className="bg-[var(--bg-card)] border border-indigo-500/30 rounded-2xl shadow-2xl max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center shrink-0">
                <Copy size={18} className="text-indigo-400" />
              </div>
              <h3 id="confirm-duplicate-title" className="text-base font-semibold text-[var(--text-1)]">
                {duplicateStage === "form"
                  ? `Duplicate "${campaign.name as string}"?`
                  : duplicateStage === "preview"
                    ? "Review segment diff"
                    : "Creating duplicate..."}
              </h3>
            </div>

            {/* ── Stage A: form ── */}
            {duplicateStage === "form" && (
              <>
                <div className="mb-4">
                  <label className="block text-xs uppercase tracking-wide text-[var(--text-3)] mb-1.5 font-semibold">
                    Name <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={duplicateName}
                    onChange={(e) => setDuplicateName(e.target.value)}
                    placeholder="New campaign name"
                    maxLength={200}
                    className="w-full px-3 py-2 rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <p className="mt-1.5 text-[10px] text-[var(--text-3)]">
                    Required. Defaults to source name + today&apos;s date; freely editable.
                  </p>
                </div>
                <div className="mb-5">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={duplicateRefreshSegment}
                      onChange={(e) => setDuplicateRefreshSegment(e.target.checked)}
                      disabled={campaign.segment_id == null}
                      className="mt-0.5 h-4 w-4 rounded border-[var(--border)] bg-[var(--bg-app)] text-indigo-500 focus:ring-indigo-500 disabled:opacity-50"
                    />
                    <div>
                      <p className="text-sm font-medium text-[var(--text-1)]">Refresh segment from customer.io</p>
                      <p className="text-[10px] text-[var(--text-3)] leading-relaxed">
                        {campaign.segment_id == null
                          ? "Disabled — this campaign has no source segment. Numbers will be copied from the source's pending list."
                          : "Re-queries customer.io for current segment members. Without this, numbers are copied from the source's pending list."}
                      </p>
                    </div>
                  </label>
                </div>
                {duplicateError && (
                  <div className="mb-4 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                    {duplicateError}
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <button
                    ref={cancelDuplicateBtnRef}
                    onClick={() => setDuplicateOpen(false)}
                    disabled={duplicateLoading}
                    className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDuplicatePreview}
                    disabled={duplicateLoading || !duplicateName.trim()}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {duplicateLoading ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                    {duplicateLoading ? "Computing diff..." : "Save → Preview"}
                  </button>
                </div>
              </>
            )}

            {/* ── Stage B: preview ── */}
            {duplicateStage === "preview" && duplicatePreview && (
              <>
                <p className="text-xs text-[var(--text-3)] mb-3 leading-relaxed">
                  {duplicatePreview.candidateSource === "segment_refresh"
                    ? `Segment refresh returned ${duplicatePreview.candidatesCount} numbers from customer.io.`
                    : `Source has ${duplicatePreview.candidatesCount} pending numbers.`}
                </p>
                <div className="mb-4 space-y-1.5 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-2)]">Overlap with source pending</span>
                    <span className="font-semibold text-amber-300">{duplicatePreview.overlap.count}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-2)]">Suppressed (auto-skipped)</span>
                    <span className="font-semibold text-red-300">{duplicatePreview.suppressed.count}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[var(--text-2)]">Recently called by another campaign (7d)</span>
                    <span className="font-semibold text-orange-300">{duplicatePreview.recentlyCalled.count}</span>
                  </div>
                </div>
                <fieldset className="mb-4">
                  <legend className="text-xs uppercase tracking-wide text-[var(--text-3)] mb-2 font-semibold">
                    Skip strategy
                  </legend>
                  <div className="space-y-2">
                    {([
                      { value: "overlap_only", label: `Skip the ${duplicatePreview.overlap.count} overlapping number${duplicatePreview.overlap.count !== 1 ? "s" : ""}`, hint: `Dial ${Math.max(0, duplicatePreview.candidatesCount - duplicatePreview.overlap.count - duplicatePreview.suppressed.count)}` },
                      { value: "overlap_and_recent", label: `Skip overlap + ${duplicatePreview.recentlyCalled.count} recently-called`, hint: `Dial ${Math.max(0, duplicatePreview.candidatesCount - duplicatePreview.overlap.count - duplicatePreview.suppressed.count - duplicatePreview.recentlyCalled.count)}` },
                      { value: "keep_all", label: `Keep all ${duplicatePreview.candidatesCount}`, hint: "May double-dial customers", warning: true },
                    ] as const).map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer transition-colors ${
                          duplicateSkipStrategy === opt.value
                            ? "border-indigo-500/50 bg-indigo-500/10"
                            : "border-[var(--border)] bg-[var(--bg-app)] hover:border-[var(--text-3)]"
                        }`}
                      >
                        <input
                          type="radio"
                          name="duplicate-skip-strategy"
                          value={opt.value}
                          checked={duplicateSkipStrategy === opt.value}
                          onChange={() => setDuplicateSkipStrategy(opt.value as SkipStrategy)}
                          className="mt-0.5 h-4 w-4"
                        />
                        <div className="flex-1">
                          <p className="text-sm text-[var(--text-1)]">{opt.label}</p>
                          <p className={`text-[10px] ${"warning" in opt && opt.warning ? "text-amber-300" : "text-[var(--text-3)]"}`}>
                            {opt.hint}
                          </p>
                        </div>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {duplicateError && (
                  <div className="mb-4 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                    {duplicateError}
                  </div>
                )}
                <div className="flex justify-between gap-2">
                  <button
                    onClick={() => setDuplicateStage("form")}
                    disabled={duplicateLoading}
                    className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50"
                  >
                    ← Back
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setDuplicateOpen(false)}
                      disabled={duplicateLoading}
                      className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleDuplicateCommit}
                      disabled={duplicateLoading}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-70 text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    >
                      <Copy size={14} />
                      Create
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* ── Stage C: committing ── */}
            {duplicateStage === "committing" && (
              <div className="py-6 flex flex-col items-center gap-3">
                <Loader2 size={28} className="text-indigo-400 animate-spin" />
                <p className="text-sm text-[var(--text-2)]">Creating new campaign + Vapi clone...</p>
                <p className="text-[10px] text-[var(--text-3)]">~3-5 seconds — please don&apos;t close this window.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Refresh-segment two-state modal — Step 12b-refresh */}
      {refreshOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-refresh-title"
          onClick={() => {
            if (refreshLoading) return;
            setRefreshOpen(false);
            setRefreshPreview(null);
            setRefreshError(null);
          }}
        >
          <div
            className="bg-[var(--bg-card)] border border-sky-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-sky-500/15 border border-sky-500/30 flex items-center justify-center shrink-0">
                <RefreshCw size={18} className={`text-sky-400 ${refreshLoading && !refreshPreview ? "animate-spin" : ""}`} />
              </div>
              <h3 id="confirm-refresh-title" className="text-base font-semibold text-[var(--text-1)]">
                Refresh segment from customer.io?
              </h3>
            </div>

            {/* Loading state — preview hasn't returned yet */}
            {refreshLoading && !refreshPreview && !refreshError && (
              <p className="text-sm text-[var(--text-2)] mb-5 leading-relaxed">
                Fetching current segment members from customer.io...
                <br />
                <span className="text-xs text-[var(--text-3)]">May take 10-30s for larger segments.</span>
              </p>
            )}

            {/* Error state */}
            {refreshError && (
              <div className="mb-5 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/10 text-sm text-red-300">
                {refreshError}
              </div>
            )}

            {/* Preview state — diff loaded */}
            {refreshPreview && !refreshError && (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg bg-[var(--bg-app)] border border-[var(--border)] p-3">
                    <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)] mb-1">Current</p>
                    <p className="text-lg font-bold text-[var(--text-1)]">{refreshPreview.existingRowsCount}</p>
                    <p className="text-[10px] text-[var(--text-3)]">total rows</p>
                  </div>
                  <div className="rounded-lg bg-[var(--bg-app)] border border-[var(--border)] p-3">
                    <p className="text-[10px] uppercase tracking-wide text-[var(--text-3)] mb-1">After</p>
                    <p className="text-lg font-bold text-[var(--text-1)]">
                      {refreshPreview.existingRowsCount + refreshPreview.toAdd.count - refreshPreview.toRemove.count}
                    </p>
                    <p className="text-[10px] text-[var(--text-3)]">eligible to dial</p>
                  </div>
                </div>
                <div className="mb-5 space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-emerald-300">+ New numbers added</span>
                    <span className="font-semibold text-emerald-300">{refreshPreview.toAdd.count}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-amber-300">− Pending removed from segment</span>
                    <span className="font-semibold text-amber-300">{refreshPreview.toRemove.count}</span>
                  </div>
                  <div className="flex items-center justify-between text-[var(--text-3)]">
                    <span>= Already pending (preserved)</span>
                    <span className="font-semibold">{refreshPreview.preservedPending.count}</span>
                  </div>
                  <div className="flex items-center justify-between text-[var(--text-3)]">
                    <span>= Already dialed (preserved)</span>
                    <span className="font-semibold">{refreshPreview.preservedDialed.total}</span>
                  </div>
                </div>
                <p className="text-xs text-[var(--text-3)] mb-5 leading-relaxed">
                  Dial history is never destroyed. Removed-from-segment pending numbers
                  get soft-marked &apos;removed_from_segment&apos; so they don&apos;t dial again, but
                  the row stays for the historical record.
                </p>
              </>
            )}

            <div className="flex justify-end gap-2">
              <button
                ref={cancelRefreshBtnRef}
                onClick={() => {
                  setRefreshOpen(false);
                  setRefreshPreview(null);
                  setRefreshError(null);
                }}
                disabled={refreshLoading}
                className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition-colors disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--text-3)]"
              >
                Cancel
              </button>
              <button
                onClick={handleRefreshCommit}
                disabled={refreshLoading || !refreshPreview || refreshError !== null}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-sky-400"
              >
                <RefreshCw size={14} className={refreshLoading ? "animate-spin" : ""} />
                {refreshLoading && refreshPreview ? "Applying..." : "Refresh"}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3 mb-6">
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-3)] uppercase tracking-wide mb-1">
            <Phone size={12} /> Numbers
          </div>
          <p className="text-xl font-bold text-[var(--text-1)]">{numbers.length}</p>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-3)] uppercase tracking-wide mb-1">
            <Clock size={12} /> Schedule
          </div>
          <p className="text-sm text-[var(--text-2)]">
            {campaign.start_at ? new Date(campaign.start_at as string).toLocaleString() : "Not set"}
            {campaign.end_at ? ` — ${new Date(campaign.end_at as string).toLocaleString()}` : ""}
          </p>
        </div>
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-3)] uppercase tracking-wide mb-1">
            <MessageSquareText size={12} /> SMS
          </div>
          <p className="text-sm text-[var(--text-2)]">{campaign.sms_enabled ? "Enabled" : "Disabled"}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4">
        <button className={tabClass("numbers")} onClick={() => setTab("numbers")}>Numbers</button>
        <button className={tabClass("calls")} onClick={() => setTab("calls")}>Calls</button>
        <button className={tabClass("settings")} onClick={() => setTab("settings")}>
          <Settings size={14} className="inline mr-1 -mt-0.5" />Settings
        </button>
      </div>

      {/* Tab content */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-sm overflow-hidden">
        {tab === "numbers" && (
          numbers.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-3)]">No numbers in this campaign.</div>
          ) : (
            <>
              <div className="px-5 py-3 border-b border-[var(--border)] flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[var(--text-3)] uppercase tracking-wide font-semibold mr-1">Breakdown</span>
                {OUTCOME_DISPLAY_ORDER.filter((o) => (outcomeBreakdown[o] ?? 0) > 0).map((o) => (
                  <span
                    key={o}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${OUTCOME_BADGE_CLASS[o] ?? "bg-gray-500/15 text-gray-400 border border-gray-500/25"}`}
                  >
                    <span className="font-semibold">{outcomeBreakdown[o]}</span>
                    <span>{OUTCOME_LABEL[o] ?? o}</span>
                  </span>
                ))}
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[var(--text-3)] text-xs uppercase tracking-wide">
                    <th className="text-left px-5 py-3 font-semibold w-12">#</th>
                    <th className="text-left px-5 py-3 font-semibold">Phone</th>
                    <th className="text-left px-5 py-3 font-semibold">Outcome</th>
                    <th className="text-left px-5 py-3 font-semibold">Attempts</th>
                    <th className="text-left px-5 py-3 font-semibold">SMS</th>
                    <th className="text-left px-5 py-3 font-semibold">Last Attempted</th>
                  </tr>
                </thead>
                <tbody>
                  {numbers.map((n, idx) => {
                    const phone = n.phone_e164 as string;
                    const sms = smsByPhone.get(phone);
                    const isExpanded = expandedSms === phone;
                    return (
                      <React.Fragment key={n.id as string}>
                        <tr className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors">
                          <td className="px-5 py-3 text-[var(--text-3)] font-mono">{idx + 1}</td>
                          <td className="px-5 py-3 text-[var(--text-1)] font-mono">{phone}</td>
                          <td className="px-5 py-3">
                            {n.outcome ? (
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${OUTCOME_BADGE_CLASS[n.outcome as string] ?? "bg-gray-500/15 text-gray-400 border border-gray-500/25"}`}>
                                {OUTCOME_LABEL[n.outcome as string] ?? (n.outcome as string)}
                              </span>
                            ) : <span className="text-[var(--text-3)]">—</span>}
                          </td>
                          <td className="px-5 py-3 text-[var(--text-2)]">{(n.attempt_count as number) ?? 0}</td>
                          <td className="px-5 py-3">
                            <SmsStatusCell
                              sms={sms}
                              expanded={isExpanded}
                              onToggle={() => setExpandedSms(isExpanded ? null : phone)}
                            />
                          </td>
                          <td className="px-5 py-3 text-[var(--text-3)]">{n.last_attempted_at ? new Date(n.last_attempted_at as string).toLocaleString() : "—"}</td>
                        </tr>
                        {isExpanded && sms && <SmsDetailRow sms={sms} />}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </>
          )
        )}

        {tab === "calls" && (
          calls.length === 0 ? (
            <div className="text-center py-12 text-sm text-[var(--text-3)]">No calls yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-3)] text-xs uppercase tracking-wide">
                  <th className="text-left px-5 py-3 font-semibold w-12">#</th>
                  <th className="text-left px-5 py-3 font-semibold">Phone</th>
                  <th className="text-left px-5 py-3 font-semibold">Status</th>
                  <th className="text-left px-5 py-3 font-semibold">Duration</th>
                  <th className="text-left px-5 py-3 font-semibold">Goal Reached</th>
                  <th className="text-left px-5 py-3 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {calls.map((c, idx) => (
                  <tr key={c.id as string} className="border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors">
                    <td className="px-5 py-3 text-[var(--text-3)] font-mono">{idx + 1}</td>
                    <td className="px-5 py-3 text-[var(--text-1)] font-mono">{phoneByNumberId.get(c.campaign_number_id as string) || "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{(c.status as string) || "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{c.duration_seconds != null ? `${c.duration_seconds}s` : "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-2)]">{c.goal_reached === true ? "Yes" : c.goal_reached === false ? "No" : "—"}</td>
                    <td className="px-5 py-3 text-[var(--text-3)]">{c.created_at ? new Date(c.created_at as string).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {tab === "settings" && (
          <div className="p-5 sm:p-6 grid gap-5">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Vapi Assistant</h3>
              <p className="text-sm text-[var(--text-1)] font-medium">{(campaign.vapi_assistant_name as string) || "—"}</p>
              <p className="text-xs text-[var(--text-3)] font-mono mt-1">{(campaign.vapi_assistant_id as string) || "—"}</p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Call Windows</h3>
              {(() => {
                const cw = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
                if (!cw || cw.length === 0) {
                  return <p className="text-sm text-[var(--text-3)]">Not configured</p>;
                }
                return (
                  <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl overflow-hidden divide-y divide-[var(--border)]">
                    {cw.map((w, i) => (
                      <div key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                        <span className="text-[var(--text-1)] font-medium">{DAY_LABEL[w.day?.toLowerCase()] ?? w.day}</span>
                        <span className="text-[var(--text-2)] font-mono text-xs">{w.start} – {w.end}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Max Attempts</h3>
                <p className="text-sm text-[var(--text-2)]">{(campaign.max_attempts as number) ?? "—"}</p>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">Retry Interval</h3>
                <p className="text-sm text-[var(--text-2)]">{campaign.retry_interval_minutes ? `${campaign.retry_interval_minutes} min` : "—"}</p>
              </div>
            </div>
            {Boolean(campaign.sms_enabled) && Boolean(campaign.sms_template) && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)] mb-2">SMS Template</h3>
                <pre className="whitespace-pre-wrap text-sm text-[var(--text-2)] bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4">
                  {String(campaign.sms_template ?? "")}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
