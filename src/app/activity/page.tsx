// src/app/activity/page.tsx
//
// Live operations console — full-page deep view of what's happening across
// every campaign right now. Four panels in a 2x2 grid:
//   1. Call activity feed (top-left, larger)
//   2. SMS activity feed (top-right)
//   3. Outcome distribution 24h (bottom-left)
//   4. Per-number recent attempts (bottom-right, larger)
//
// Data: GET /api/dashboard/activity, polled every 30s.
// 1-second clock ticks for "Xs ago" relative timestamps.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, Hash, MessageSquare,
  PhoneCall, PhoneOff, Phone, Target, XCircle,
} from "lucide-react";
import { RefreshCWIcon } from "@/components/icons/animated/refresh-cw";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";
import Pagination from "@/components/Pagination";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";

interface CallEvent {
  id: string;
  createdAt: string;
  status: string;
  durationSeconds: number | null;
  goalReached: boolean | null;
  campaignId: string;
  campaignName: string;
  phoneE164: string;
}

interface SmsEvent {
  id: string;
  createdAt: string;
  status: string;
  toPhoneE164: string;
  bodyPreview: string;
  errorMessage: string | null;
  campaignId: string;
  campaignName: string;
}

interface PerNumberRow {
  campaignNumberId: string;
  phoneE164: string;
  campaignId: string;
  campaignName: string;
  outcome: string;
  attemptCount: number;
  lastAttemptedAt: string | null;
  lastDurationSeconds: number | null;
  lastStatus: string | null;
}

interface ActivityResponse {
  fetchedAt: string;
  recentCalls: CallEvent[];
  recentSms: SmsEvent[];
  outcomes24h: { total: number; byStatus: Record<string, number>; goalReachedCount: number };
  perNumberRecent: PerNumberRow[];
}

const POLL_MS = 30_000;
const PAGE_SIZE = 10;

// Client-side pagination for the live feeds. Clamps the page on each 30s poll
// (no jarring reset), resets to page 1 when the filter signature changes.
function usePaged<T>(items: T[], resetKey: string) {
  const [page, setPage] = useState(1);
  // Reset to page 1 when the filter changes — React's store-previous-value
  // pattern (adjust state during render), not an effect, so it doesn't trip
  // react-hooks/set-state-in-effect and applies before paint (no flash).
  const [prevKey, setPrevKey] = useState(resetKey);
  if (prevKey !== resetKey) {
    setPrevKey(resetKey);
    setPage(1);
  }
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  return { pageItems, page: safePage, setPage, totalPages, total: items.length };
}

export default function ActivityPage() {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());

  // 1s clock for "Xs ago" relative timestamps
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Load function — shared between polling + manual refresh.
  const loadActivity = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/activity", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as ActivityResponse;
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load activity");
    }
  }, []);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try { await loadActivity(); } finally { setIsRefreshing(false); }
  }, [loadActivity]);

  // 30s polling
  useEffect(() => {
    loadActivity();
    const id = window.setInterval(loadActivity, POLL_MS);
    return () => clearInterval(id);
  }, [loadActivity]);

  // ── Filters: campaign across all feeds; call-status chips on the Call feed. ──
  const campaignOptions = useMemo<DropdownOption[]>(() => {
    const map = new Map<string, string>();
    for (const c of data?.recentCalls ?? []) map.set(c.campaignId, c.campaignName);
    for (const s of data?.recentSms ?? []) map.set(s.campaignId, s.campaignName);
    for (const r of data?.perNumberRecent ?? []) map.set(r.campaignId, r.campaignName);
    const opts = [...map.entries()].map(([value, label]) => ({ value, label }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: "all", label: "All campaigns" }, ...opts];
  }, [data]);

  const callStatuses = useMemo(() => {
    const set = new Set<string>();
    for (const c of data?.recentCalls ?? []) set.add(c.status);
    return Array.from(set).sort();
  }, [data]);

  const filteredCalls = useMemo(
    () => (data?.recentCalls ?? []).filter(
      (c) => (campaignFilter === "all" || c.campaignId === campaignFilter) &&
        (statusFilter.size === 0 || statusFilter.has(c.status)),
    ),
    [data, campaignFilter, statusFilter],
  );
  const filteredSms = useMemo(
    () => (data?.recentSms ?? []).filter((s) => campaignFilter === "all" || s.campaignId === campaignFilter),
    [data, campaignFilter],
  );
  const filteredNumbers = useMemo(
    () => (data?.perNumberRecent ?? []).filter((r) => campaignFilter === "all" || r.campaignId === campaignFilter),
    [data, campaignFilter],
  );

  const filterKey = `${campaignFilter}|${Array.from(statusFilter).sort().join(",")}`;
  const callsPaged = usePaged(filteredCalls, filterKey);
  const smsPaged = usePaged(filteredSms, filterKey);
  const numbersPaged = usePaged(filteredNumbers, filterKey);

  const toggleStatus = (s: string) =>
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const filtersActive = campaignFilter !== "all" || statusFilter.size > 0;

  return (
    <div className="p-6 max-w-[1600px] mx-auto w-full grid gap-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight flex items-center gap-2.5">
            <span className="relative inline-flex w-2.5 h-2.5">
              <span className="absolute inset-0 rounded-full bg-emerald-500 animate-ping opacity-60" />
              <span className="relative w-2.5 h-2.5 rounded-full bg-emerald-500" />
            </span>
            Live Activity
          </h1>
          <p className="text-sm text-[var(--text-3)] mt-1">
            Everything happening across all campaigns · last 24 hours
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={isRefreshing}
            title="Refresh now"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <HoverIcon icon={RefreshCWIcon} size={12} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
          <span className="text-[10px] text-[var(--text-3)] font-mono">auto every 30s</span>
        </div>
      </div>

      {/* Filter bar — campaign (all feeds) + call-status chips (Call feed). */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="w-60">
          <StyledSelect
            size="sm"
            options={campaignOptions}
            value={campaignFilter}
            onChange={setCampaignFilter}
            placeholder="All campaigns"
          />
        </div>
        {callStatuses.length > 0 && (
          <>
            <span className="w-px h-5 bg-[var(--border)] mx-0.5" />
            <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Call outcome</span>
            {callStatuses.map((s) => {
              const on = statusFilter.has(s);
              const tone = callStatusTone(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                    on ? `${tone.bg} ${tone.text} ${tone.border}` : "bg-transparent text-[var(--text-3)] border-[var(--border)] opacity-60 hover:opacity-100"
                  }`}
                >
                  {s.replace(/_/g, " ")}
                </button>
              );
            })}
          </>
        )}
        {filtersActive && (
          <button
            type="button"
            onClick={() => { setCampaignFilter("all"); setStatusFilter(new Set()); }}
            className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2 py-1 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)]"
          >
            Reset
          </button>
        )}
      </div>

      {/* Row 1: Call feed (large) + SMS feed */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-5">
        <Card
          title="Call Activity"
          icon={<PhoneCall size={14} className="text-blue-400" />}
          sub={data ? `${filteredCalls.length} of ${data.outcomes24h.total} calls (24h)` : "Loading…"}
        >
          <CallFeed calls={callsPaged.pageItems} now={now} loading={!data} />
          {callsPaged.total > PAGE_SIZE && (
            <Pagination currentPage={callsPaged.page} totalPages={callsPaged.totalPages} totalItems={callsPaged.total} pageSize={PAGE_SIZE} onPageChange={callsPaged.setPage} />
          )}
        </Card>

        <Card
          title="SMS Activity"
          icon={<MessageSquare size={14} className="text-violet-400" />}
          sub={data ? `${filteredSms.length} most recent` : "Loading…"}
        >
          <SmsFeed sms={smsPaged.pageItems} now={now} loading={!data} />
          {smsPaged.total > PAGE_SIZE && (
            <Pagination currentPage={smsPaged.page} totalPages={smsPaged.totalPages} totalItems={smsPaged.total} pageSize={PAGE_SIZE} onPageChange={smsPaged.setPage} />
          )}
        </Card>
      </div>

      {/* Row 2: Outcome distribution + Per-number (large) */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.4fr] gap-5">
        <Card
          title="Outcomes · last 24h"
          icon={<Target size={14} className="text-amber-400" />}
          sub={data ? `${data.outcomes24h.total} total · ${data.outcomes24h.goalReachedCount} goal-reached` : "Loading…"}
        >
          <OutcomeBar outcomes={data?.outcomes24h ?? null} loading={!data} />
        </Card>

        <Card
          title="Recent Numbers"
          icon={<Hash size={14} className="text-cyan-400" />}
          sub={data ? `${filteredNumbers.length} most recently attempted` : "Loading…"}
        >
          <PerNumberTable rows={numbersPaged.pageItems} now={now} loading={!data} />
          {numbersPaged.total > PAGE_SIZE && (
            <Pagination currentPage={numbersPaged.page} totalPages={numbersPaged.totalPages} totalItems={numbersPaged.total} pageSize={PAGE_SIZE} onPageChange={numbersPaged.setPage} />
          )}
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Cards / panels
// ─────────────────────────────────────────────────────────────────────────

function Card({
  title, icon, sub, children,
}: { title: string; icon: React.ReactNode; sub: string; children: React.ReactNode }) {
  return (
    <section className="glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <div className="text-[15px] font-semibold">{title}</div>
            <div className="text-xs text-[var(--text-3)] mt-0.5">{sub}</div>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function CallFeed({ calls, now, loading }: { calls: CallEvent[]; now: Date; loading: boolean }) {
  if (loading) return <SkeletonRows count={6} />;
  if (calls.length === 0) return <EmptyState icon={<PhoneOff size={18} />} message="No calls in the last 24 hours" />;
  return (
    <div className="flex flex-col gap-1">
      {calls.map((c) => <CallRow key={c.id} c={c} now={now} />)}
    </div>
  );
}

function CallRow({ c, now }: { c: CallEvent; now: Date }) {
  const tone = callStatusTone(c.status);
  const dur = c.durationSeconds != null ? formatDur(c.durationSeconds) : null;

  return (
    <Link
      href={`/campaigns/v2/${c.campaignId}`}
      className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-[var(--bg-hover)] transition border border-transparent hover:border-[var(--border)]"
    >
      <div className={`w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 ${tone.bg} ${tone.text}`}>
        <CallStatusIcon status={c.status} size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-mono font-medium text-[var(--text-1)]">{c.phoneE164 || "—"}</span>
          <span className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border ${tone.bg} ${tone.text} ${tone.border}`}>
            {c.status.replace(/_/g, " ")}
          </span>
          {c.goalReached && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
              <Target size={9} /> goal
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--text-3)] mt-0.5 truncate">
          {c.campaignName}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        {dur && <div className="font-mono text-[11px] text-[var(--text-2)] tabular-nums">{dur}</div>}
        <div className="font-mono text-[10px] text-[var(--text-3)] mt-0.5">{formatRelativeSync(c.createdAt, now)}</div>
      </div>
    </Link>
  );
}

function SmsFeed({ sms, now, loading }: { sms: SmsEvent[]; now: Date; loading: boolean }) {
  if (loading) return <SkeletonRows count={5} />;
  if (sms.length === 0) return <EmptyState icon={<MessageSquare size={18} />} message="No SMS sent in the last 24 hours" />;
  return (
    <div className="flex flex-col gap-1">
      {sms.map((s) => <SmsRow key={s.id} s={s} now={now} />)}
    </div>
  );
}

function SmsRow({ s, now }: { s: SmsEvent; now: Date }) {
  const tone = smsStatusTone(s.status);

  return (
    <Link
      href={`/campaigns/v2/${s.campaignId}`}
      className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-[var(--bg-hover)] transition border border-transparent hover:border-[var(--border)]"
    >
      <div className={`w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 ${tone.bg} ${tone.text}`}>
        <MessageSquare size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-mono font-medium text-[var(--text-1)]">{s.toPhoneE164}</span>
          <span className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border ${tone.bg} ${tone.text} ${tone.border}`}>
            {s.status}
          </span>
        </div>
        <div className="text-[11px] text-[var(--text-2)] mt-0.5 line-clamp-1">
          {s.bodyPreview}
        </div>
        {s.errorMessage && (
          <div className="text-[10px] text-red-400 mt-0.5 inline-flex items-center gap-1">
            <AlertCircle size={9} /> {s.errorMessage}
          </div>
        )}
        <div className="text-[10px] text-[var(--text-3)] mt-0.5">
          {s.campaignName}
        </div>
      </div>
      <div className="font-mono text-[10px] text-[var(--text-3)] flex-shrink-0">
        {formatRelativeSync(s.createdAt, now)}
      </div>
    </Link>
  );
}

function OutcomeBar({ outcomes, loading }: { outcomes: ActivityResponse["outcomes24h"] | null; loading: boolean }) {
  // Hooks must run unconditionally — compute segments first, branch on empty after.
  const segments = useOutcomeSegments(outcomes);

  if (loading) return <div className="h-32 flex items-center justify-center text-xs text-[var(--text-3)]">Loading…</div>;
  if (!outcomes || outcomes.total === 0) {
    return <EmptyState icon={<Target size={18} />} message="No calls in the last 24 hours" />;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Stacked bar */}
      <div className="h-3 w-full rounded-full overflow-hidden flex bg-[var(--bg-elevated)]">
        {segments.map((seg) => (
          <div key={seg.status} style={{ width: `${seg.pct * 100}%` }} className={seg.bgSolid} title={`${seg.label}: ${seg.count} (${(seg.pct * 100).toFixed(1)}%)`} />
        ))}
      </div>

      {/* Legend */}
      <div className="grid grid-cols-2 gap-2">
        {segments.map((seg) => (
          <div key={seg.status} className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]/50">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${seg.bgSolid}`} />
              <span className="text-[12px] text-[var(--text-2)] truncate">{seg.label}</span>
            </div>
            <div className="text-[12px] font-mono tabular-nums flex-shrink-0">
              <span className="text-[var(--text-1)] font-semibold">{seg.count}</span>
              <span className="text-[var(--text-3)] ml-1.5">{(seg.pct * 100).toFixed(0)}%</span>
            </div>
          </div>
        ))}
      </div>

      {/* Goal-reached emphasis */}
      <div className="flex items-center justify-between gap-2 py-2.5 px-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-emerald-400" />
          <span className="text-xs font-medium text-emerald-300">Goal reached</span>
        </div>
        <div className="font-mono text-sm tabular-nums">
          <span className="text-emerald-300 font-semibold">{outcomes.goalReachedCount}</span>
          <span className="text-emerald-400/60 ml-2 text-[11px]">
            {outcomes.total > 0 ? `${((outcomes.goalReachedCount / outcomes.total) * 100).toFixed(1)}%` : "0%"}
          </span>
        </div>
      </div>
    </div>
  );
}

function useOutcomeSegments(outcomes: ActivityResponse["outcomes24h"] | null) {
  return useMemo(() => {
    if (!outcomes || outcomes.total === 0) return [];
    return Object.entries(outcomes.byStatus)
      .map(([status, count]) => {
        const tone = callStatusTone(status);
        return {
          status,
          count,
          label: status.replace(/_/g, " "),
          pct: count / outcomes.total,
          bgSolid: tone.bgSolid,
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [outcomes]);
}

function PerNumberTable({ rows, now, loading }: { rows: PerNumberRow[]; now: Date; loading: boolean }) {
  if (loading) return <SkeletonRows count={5} />;
  if (rows.length === 0) return <EmptyState icon={<Hash size={18} />} message="No number attempts in the last 24 hours" />;

  return (
    <div className="overflow-x-auto -mx-2">
      <table className="w-full text-sm min-w-[640px]">
        <thead className="sticky top-0 bg-[var(--bg-card)] z-10">
          <tr>
            <Th>Phone</Th>
            <Th>Campaign</Th>
            <Th alignRight>Attempts</Th>
            <Th>Outcome</Th>
            <Th alignRight>Last duration</Th>
            <Th>Last call</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const outcomeTone = numberOutcomeTone(r.outcome);
            const callTone = r.lastStatus ? callStatusTone(r.lastStatus) : null;
            return (
              <tr key={r.campaignNumberId} className="border-b border-[var(--border)] last:border-b-0">
                <td className="py-2.5 px-2 font-mono text-xs text-[var(--text-1)]">{r.phoneE164}</td>
                <td className="py-2.5 px-2">
                  <Link href={`/campaigns/v2/${r.campaignId}`} className="text-xs text-[var(--text-2)] hover:text-blue-400 truncate block max-w-[200px]">
                    {r.campaignName}
                  </Link>
                </td>
                <td className="py-2.5 px-2 text-right font-mono text-xs text-[var(--text-2)] tabular-nums">{r.attemptCount}</td>
                <td className="py-2.5 px-2">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-mono border ${outcomeTone.bg} ${outcomeTone.text} ${outcomeTone.border}`}>
                    {r.outcome.replace(/_/g, " ")}
                  </span>
                </td>
                <td className="py-2.5 px-2 text-right font-mono text-xs text-[var(--text-2)] tabular-nums">
                  {r.lastDurationSeconds != null ? formatDur(r.lastDurationSeconds) : "—"}
                </td>
                <td className="py-2.5 px-2">
                  {r.lastStatus && callTone ? (
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border ${callTone.bg} ${callTone.text} ${callTone.border}`}>
                        {r.lastStatus.replace(/_/g, " ")}
                      </span>
                      <span className="font-mono text-[10px] text-[var(--text-3)]">{r.lastAttemptedAt ? formatRelativeSync(r.lastAttemptedAt, now) : "—"}</span>
                    </div>
                  ) : (
                    <span className="text-[10px] text-[var(--text-3)]">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers + tone maps
// ─────────────────────────────────────────────────────────────────────────

interface Tone { bg: string; bgSolid: string; text: string; border: string; }

function callStatusTone(status: string): Tone {
  switch (status) {
    case "answered":
    case "completed":
      return { bg: "bg-blue-500/15", bgSolid: "bg-blue-500", text: "text-blue-400", border: "border-blue-500/30" };
    case "in_progress":
      return { bg: "bg-cyan-500/15", bgSolid: "bg-cyan-500", text: "text-cyan-400", border: "border-cyan-500/30" };
    case "ringing":
    case "initiated":
      return { bg: "bg-sky-500/15", bgSolid: "bg-sky-500", text: "text-sky-400", border: "border-sky-500/30" };
    case "no_answer":
    case "busy":
      return { bg: "bg-amber-500/15", bgSolid: "bg-amber-500", text: "text-amber-400", border: "border-amber-500/30" };
    case "voicemail":
      return { bg: "bg-violet-500/15", bgSolid: "bg-violet-500", text: "text-violet-400", border: "border-violet-500/30" };
    case "failed":
      return { bg: "bg-red-500/15", bgSolid: "bg-red-500", text: "text-red-400", border: "border-red-500/30" };
    case "canceled":
      return { bg: "bg-[var(--bg-elevated)]", bgSolid: "bg-[var(--text-3)]", text: "text-[var(--text-3)]", border: "border-[var(--border)]" };
    default:
      return { bg: "bg-[var(--bg-elevated)]", bgSolid: "bg-[var(--text-3)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
  }
}

/**
 * Stable component that picks the lucide icon at JSX time based on status.
 * Replaces an earlier `callStatusIcon(status)` that RETURNED a component
 * identifier — that pattern trips `react-hooks/static-components` because
 * the component identifier looks fresh to React on every render.
 */
function CallStatusIcon({ status, size = 14, className }: { status: string; size?: number; className?: string }) {
  switch (status) {
    case "answered":
    case "completed":
      return <Phone size={size} className={className} />;
    case "in_progress":
      return <PhoneCall size={size} className={className} />;
    case "no_answer":
    case "busy":
    case "voicemail":
      return <PhoneOff size={size} className={className} />;
    case "failed":
    case "canceled":
      return <XCircle size={size} className={className} />;
    case "ringing":
    case "initiated":
      return <Activity size={size} className={className} />;
    default:
      return <Phone size={size} className={className} />;
  }
}

function smsStatusTone(status: string): Tone {
  switch (status) {
    case "delivered":
      return { bg: "bg-emerald-500/15", bgSolid: "bg-emerald-500", text: "text-emerald-400", border: "border-emerald-500/30" };
    case "sent":
      return { bg: "bg-blue-500/15", bgSolid: "bg-blue-500", text: "text-blue-400", border: "border-blue-500/30" };
    case "queued":
      return { bg: "bg-[var(--bg-elevated)]", bgSolid: "bg-[var(--text-3)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
    case "failed":
    case "undelivered":
      return { bg: "bg-red-500/15", bgSolid: "bg-red-500", text: "text-red-400", border: "border-red-500/30" };
    default:
      return { bg: "bg-[var(--bg-elevated)]", bgSolid: "bg-[var(--text-3)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
  }
}

function numberOutcomeTone(outcome: string): Tone {
  switch (outcome) {
    case "sent_sms":
      return { bg: "bg-emerald-500/15", bgSolid: "bg-emerald-500", text: "text-emerald-400", border: "border-emerald-500/30" };
    case "sms_delivered":
      return { bg: "bg-teal-500/15", bgSolid: "bg-teal-500", text: "text-teal-400", border: "border-teal-500/30" };
    case "in_progress":
      return { bg: "bg-cyan-500/15", bgSolid: "bg-cyan-500", text: "text-cyan-400", border: "border-cyan-500/30" };
    case "pending":
      return { bg: "bg-blue-500/15", bgSolid: "bg-blue-500", text: "text-blue-400", border: "border-blue-500/30" };
    case "pending_retry":
      return { bg: "bg-amber-500/15", bgSolid: "bg-amber-500", text: "text-amber-400", border: "border-amber-500/30" };
    case "not_interested":
    case "declined_offer":
      return { bg: "bg-violet-500/15", bgSolid: "bg-violet-500", text: "text-violet-400", border: "border-violet-500/30" };
    case "wrong_number":
    case "suppressed":
    case "unreached":
      return { bg: "bg-red-500/15", bgSolid: "bg-red-500", text: "text-red-400", border: "border-red-500/30" };
    default:
      return { bg: "bg-[var(--bg-elevated)]", bgSolid: "bg-[var(--text-3)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
  }
}

function Th({ children, alignRight }: { children: React.ReactNode; alignRight?: boolean }) {
  return (
    <th className={`pb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] border-b border-[var(--border)] ${alignRight ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] animate-pulse" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-3/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-2.5 w-2/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, message }: { icon: React.ReactNode; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)]">
        {icon}
      </div>
      <p className="text-xs text-[var(--text-3)]">{message}</p>
    </div>
  );
}

function formatDur(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
}

function formatRelativeSync(iso: string, now: Date): string {
  const ageSec = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}
