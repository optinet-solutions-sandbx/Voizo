"use client";

import React from "react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, Bot, ChevronDown, Clock, Download, MessageSquareText, Phone, Play, Pause, Settings, Loader2, StopCircle, AlertTriangle } from "lucide-react";
import { fetchCampaignV2, fetchCampaignNumbersV2, fetchCallsV2, fetchSmsMessagesV2, updateCampaignV2Status } from "@/lib/campaignV2Data";
import { useCampaignExport, type ExportType } from "@/lib/useCampaignExport";

type Row = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "bg-gray-500/15 text-gray-400 border-gray-500/25",
    scheduled: "bg-cyan-500/15 text-cyan-400 border-cyan-500/25",
    running: "bg-emerald-500/15 text-emerald-400 border-emerald-500/25",
    paused: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
    completed: "bg-blue-500/15 text-blue-400 border-blue-500/25",
    archived: "bg-gray-500/15 text-gray-400 border-gray-500/25",
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${map[status] ?? map.draft}`}>
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
  in_progress: "Dialing",
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
  pending: "bg-gray-500/15 text-gray-400 border border-gray-500/25",
  in_progress: "bg-blue-500/15 text-blue-400 border border-blue-500/25",
  pending_retry: "bg-amber-500/15 text-amber-400 border border-amber-500/25",
  sent_sms: "bg-emerald-500/15 text-emerald-400 border border-emerald-500/25",
  not_interested: "bg-gray-500/15 text-gray-400 border border-gray-500/25",
  declined_offer: "bg-gray-500/15 text-gray-400 border border-gray-500/25",
  wrong_number: "bg-gray-500/15 text-gray-400 border border-gray-500/25",
  unreached: "bg-red-500/15 text-red-400 border border-red-500/25",
  suppressed: "bg-purple-500/15 text-purple-400 border border-purple-500/25",
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

  // Export Reports dropdown state. The hook drives both CSV-only and
  // CSV+audio exports — see src/lib/useCampaignExport.ts. Audio bundles
  // route through /api/recordings/proxy to bypass storage.vapi.ai CORS.
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const {
    startExport,
    cancel: cancelExport,
    exporting,
    progress: exportProgress,
    error: exportError,
  } = useCampaignExport(id);

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

  // Close the Export dropdown on Escape, matching the confirm-stop modal a11y.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportMenuOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [exportMenuOpen]);

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
            {/* Export Reports — visible in all campaign states. CSV-only
                or CSV+audio bundles via useCampaignExport. */}
            <div className="relative">
              <button
                onClick={() => setExportMenuOpen((v) => !v)}
                disabled={exporting}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-70 text-[var(--text-2)] text-sm font-medium transition-colors"
              >
                {exporting ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Download size={15} />
                )}
                {exporting ? "Exporting..." : "Export"}
                <ChevronDown
                  size={12}
                  className={`transition-transform ${exportMenuOpen ? "rotate-180" : ""}`}
                />
              </button>
              {exportMenuOpen && !exporting && (
                <div className="absolute right-0 mt-2 w-72 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] shadow-xl z-50 overflow-hidden divide-y divide-[var(--border)]">
                  <div className="px-3 py-2 text-[10px] uppercase font-semibold text-[var(--text-3)] tracking-wide">
                    CSV Reports
                  </div>
                  <div className="py-1">
                    {([
                      ["all", "All Calls"],
                      ["sms_sent", "SMS Sent"],
                      ["not_interested_or_declined", "Not Interested / Declined"],
                      ["voicemail", "Voicemails"],
                      ["unreached_or_retry", "Unreached / Awaiting Retry"],
                      ["wrong_number", "Wrong Numbers"],
                    ] as [ExportType, string][]).map(([type, label]) => (
                      <button
                        key={`csv-${type}`}
                        onClick={() => {
                          setExportMenuOpen(false);
                          startExport(type, false);
                        }}
                        className="w-full text-left px-4 py-2 text-xs text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
                      >
                        {label} (.csv)
                      </button>
                    ))}
                  </div>
                  <div className="px-3 py-2 text-[10px] uppercase font-semibold text-[var(--text-3)] tracking-wide">
                    Audio Bundles (.zip)
                  </div>
                  <div className="py-1">
                    {([
                      ["all", "All Recordings"],
                      ["voicemail", "Voicemails Only"],
                      ["sms_sent", "SMS-Reached Only"],
                    ] as [ExportType, string][]).map(([type, label]) => (
                      <button
                        key={`zip-${type}`}
                        onClick={() => {
                          setExportMenuOpen(false);
                          startExport(type, true);
                        }}
                        className="w-full text-left px-4 py-2 text-xs text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
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

      {/* Export progress overlay — covers the screen during a CSV/audio export.
          Mirrors the confirm-stop modal pattern (fixed inset-0 z-50, backdrop
          blur). Cancel triggers the hook's AbortController so the operator can
          bail mid-zip. */}
      {exporting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="export-progress-title"
        >
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center">
            <Loader2 size={28} className="text-blue-400 animate-spin mx-auto mb-3" />
            <h4
              id="export-progress-title"
              className="text-sm font-semibold text-[var(--text-1)] mb-1"
            >
              Processing Export
            </h4>
            <p className="text-xs text-[var(--text-3)] mb-4">{exportProgress.stage}</p>
            {exportProgress.total > 0 && (
              <>
                <div className="w-full bg-[var(--bg-app)] rounded-full h-2 mb-3 overflow-hidden">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.round((exportProgress.current / exportProgress.total) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-[10px] text-[var(--text-3)] mb-4">
                  {exportProgress.current} / {exportProgress.total}
                </p>
              </>
            )}
            <button
              onClick={cancelExport}
              className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-xs font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Export error banner — shows after a failed/cancelled export.
          Persists until the next export attempt clears it. */}
      {exportError && !exporting && (
        <div className="mb-4 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-300">
          Export: {exportError}
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
