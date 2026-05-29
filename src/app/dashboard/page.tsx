// src/app/dashboard/page.tsx
//
// Home / Dashboard — Material Admin layout.
// Hero chart + 4 stat cards + 2-col widget grid (Recent Campaigns, Active Workers).
//
// Data sources:
//   - /api/dashboard/metrics  — aggregated metrics + 30-day series + recent campaigns
//                               (fetched on mount + every 60s)
//   - /api/workers/state      — live pool slots (polled every 5s, same as /workers)
//
// All charts/sparklines are inline SVG. Hero chart is dynamic from series30d;
// stat-card sparklines are decorative (static).

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, CheckCircle2, MapPin, MessageSquare,
  PhoneCall, PhoneOff, Phone, Radio, Target, Wrench, XCircle, Zap,
} from "lucide-react";
import { RefreshCWIcon } from "@/components/icons/animated/refresh-cw";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";

interface SeriesPoint { day: string; calls: number; goals: number; }

interface RecentCampaign {
  id: string;
  name: string;
  status: string;
  timezone: string;
  vapi_assistant_name: string | null;
  total_calls_30d: number;
  connect_rate_30d: number;
  success_rate_30d: number;
  last_call_at: string | null;
}

interface MetricsResponse {
  fetchedAt: string;
  callsToday: number;
  callsYesterday: number;
  connectRate7d: number;
  connectRate7dPrior: number;
  goalRate7d: number;
  goalRate7dPrior: number;
  series30d: SeriesPoint[];
  recent: RecentCampaign[];
}

interface PoolSlot {
  slotIndex: number;
  status: "free" | "leased" | "maintenance";
  campaign: { name: string; timezone: string; vapiAssistantName: string | null } | null;
  inFlightCall: { phoneE164: string | null; durationMs: number } | null;
  leasedDurationMs: number | null;
  notes: string | null;
}

interface ActivityCall {
  id: string;
  createdAt: string;
  status: string;
  durationSeconds: number | null;
  goalReached: boolean | null;
  campaignId: string;
  campaignName: string;
  phoneE164: string;
}

interface ActivitySms {
  id: string;
  createdAt: string;
  status: string;
  toPhoneE164: string;
  bodyPreview: string;
  errorMessage: string | null;
  campaignId: string;
  campaignName: string;
}

const METRICS_POLL_MS = 60_000;
const WORKERS_POLL_MS = 5_000;
const ACTIVITY_POLL_MS = 30_000;
const COMPACT_ACTIVITY_LIMIT = 6;

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [slots, setSlots] = useState<PoolSlot[]>([]);
  const [activityCalls, setActivityCalls] = useState<ActivityCall[] | null>(null);
  const [activitySms, setActivitySms] = useState<ActivitySms[] | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 1s clock for the worker local-time display
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Load functions (shared between polling + manual refresh) ──
  const loadMetrics = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/metrics", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as MetricsResponse;
      setMetrics(body);
      setMetricsError(null);
    } catch (err) {
      setMetricsError(err instanceof Error ? err.message : "Failed to load metrics");
    }
  }, []);

  const loadWorkers = useCallback(async () => {
    try {
      const r = await fetch("/api/workers/state", { cache: "no-store" });
      if (!r.ok) return;
      const body = await r.json();
      setSlots(body.slots ?? []);
    } catch { /* silent */ }
  }, []);

  const loadActivity = useCallback(async () => {
    try {
      const r = await fetch("/api/dashboard/activity", { cache: "no-store" });
      if (!r.ok) return;
      const body = await r.json();
      setActivityCalls((body.recentCalls as ActivityCall[] | undefined)?.slice(0, COMPACT_ACTIVITY_LIMIT) ?? []);
      setActivitySms((body.recentSms as ActivitySms[] | undefined)?.slice(0, COMPACT_ACTIVITY_LIMIT) ?? []);
    } catch { /* silent */ }
  }, []);

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([loadMetrics(), loadWorkers(), loadActivity()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadMetrics, loadWorkers, loadActivity]);

  // ── Auto-poll loops ──
  useEffect(() => {
    loadMetrics();
    const id = window.setInterval(loadMetrics, METRICS_POLL_MS);
    return () => clearInterval(id);
  }, [loadMetrics]);

  useEffect(() => {
    loadWorkers();
    const id = window.setInterval(loadWorkers, WORKERS_POLL_MS);
    return () => clearInterval(id);
  }, [loadWorkers]);

  useEffect(() => {
    loadActivity();
    const id = window.setInterval(loadActivity, ACTIVITY_POLL_MS);
    return () => clearInterval(id);
  }, [loadActivity]);

  // ── Derived ──
  const onCallCount = slots.filter(s => s.status === "leased" && s.inFlightCall).length;
  const freeCount   = slots.filter(s => s.status === "free").length;
  const maintCount  = slots.filter(s => s.status === "maintenance").length;
  const totalSlots  = slots.length || 5;

  const callsToday = metrics?.callsToday ?? 0;
  const callsYesterday = metrics?.callsYesterday ?? 0;
  const callsDeltaPct =
    callsYesterday > 0 ? ((callsToday - callsYesterday) / callsYesterday) * 100 : null;

  const connectRate = metrics?.connectRate7d ?? 0;
  const connectDelta = metrics ? metrics.connectRate7d - metrics.connectRate7dPrior : 0;
  const goalRate = metrics?.goalRate7d ?? 0;
  const goalDelta = metrics ? metrics.goalRate7d - metrics.goalRate7dPrior : 0;

  const recent = metrics?.recent ?? [];

  // Hero chart paths (memoized — recompute only when series changes)
  const heroPaths = useMemo(() => buildHeroPaths(metrics?.series30d ?? []), [metrics?.series30d]);

  return (
    <div className="p-6 max-w-[1400px] mx-auto w-full grid gap-5">
      {/* Welcome */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight">Welcome back</h1>
          <p className="text-sm text-[var(--text-3)] mt-1">Here&apos;s what your dialler pool has been up to.</p>
        </div>
        <div className="flex items-center gap-2">
          {metricsError && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {metricsError}
            </span>
          )}
          <button
            onClick={refreshAll}
            disabled={isRefreshing}
            title="Refresh all panels"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <HoverIcon icon={RefreshCWIcon} size={12} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* HERO chart */}
      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden">
        <div className="flex items-start justify-between px-6 pt-5 pb-2">
          <div>
            <div className="text-[15px] font-semibold">Calls Performance</div>
            <div className="text-xs text-[var(--text-3)] mt-1">Last 30 days · all campaigns</div>
            <div className="flex gap-4 mt-1.5 text-[11px] text-[var(--text-2)]">
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-blue-500" /> Calls placed</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Goal reached</span>
            </div>
          </div>
        </div>
        <svg viewBox="0 0 1200 220" preserveAspectRatio="none" className="w-full h-[220px] block">
          <defs>
            <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#4f8df8" stopOpacity="0.35"/>
              <stop offset="100%" stopColor="#4f8df8" stopOpacity="0"/>
            </linearGradient>
            <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#10b981" stopOpacity="0.30"/>
              <stop offset="100%" stopColor="#10b981" stopOpacity="0"/>
            </linearGradient>
          </defs>
          {heroPaths.callsArea && <path d={heroPaths.callsArea} fill="url(#g1)" />}
          {heroPaths.callsLine && <path d={heroPaths.callsLine} fill="none" stroke="#4f8df8" strokeWidth="2" />}
          {heroPaths.goalsArea && <path d={heroPaths.goalsArea} fill="url(#g2)" />}
          {heroPaths.goalsLine && <path d={heroPaths.goalsLine} fill="none" stroke="#10b981" strokeWidth="2" />}
          {(!metrics || metrics.series30d.every(p => p.calls === 0)) && (
            <text x={600} y={110} textAnchor="middle" fontSize={11} fill="var(--text-3)" fontFamily="var(--font-geist-sans)">
              {metrics ? "No calls in the last 30 days" : "Loading 30-day series…"}
            </text>
          )}
        </svg>
      </section>

      {/* Stat strip */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <StatCard
          label="Calls Today"
          value={callsToday.toLocaleString()}
          delta={
            callsDeltaPct === null
              ? "no baseline yet"
              : `${callsDeltaPct >= 0 ? "+" : ""}${callsDeltaPct.toFixed(1)}% vs yesterday`
          }
          deltaColor={callsDeltaPct === null ? "text-[var(--text-3)]" : callsDeltaPct >= 0 ? "text-emerald-400" : "text-red-400"}
          icon={<PhoneCall size={13} />}
          sparkColor="#4f8df8"
        />
        <StatCard
          label="Connect Rate"
          value={`${(connectRate * 100).toFixed(1)}%`}
          delta={formatDeltaPp(connectDelta)}
          deltaColor={connectDelta >= 0 ? "text-emerald-400" : "text-red-400"}
          icon={<Zap size={13} />}
          sparkColor="#10b981"
        />
        <StatCard
          label="Goal Rate"
          value={`${(goalRate * 100).toFixed(1)}%`}
          delta={formatDeltaPp(goalDelta)}
          deltaColor={goalDelta >= 0 ? "text-emerald-400" : "text-red-400"}
          icon={<Activity size={13} />}
          sparkColor="#f59e0b"
        />
        <StatCard
          label="Active Workers"
          value={`${onCallCount} / ${totalSlots}`}
          delta={`${freeCount} idle · ${maintCount} maint`}
          deltaColor="text-[var(--text-3)]"
          icon={<Radio size={13} />}
          bars
        />
      </section>

      {/* Row 1: Recent campaigns + Active workers */}
      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-5">
        <Card title="Recent Campaigns" sub="Top 6 by activity in last 30 days" action={<Link href="/campaigns" className="text-xs text-blue-400 px-2 py-1 rounded hover:bg-[var(--bg-elevated)]">View all →</Link>}>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th alignRight>Calls</Th>
                <Th alignRight>Connect</Th>
                <Th alignRight>Goal</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr><td colSpan={5} className="p-8 text-center text-xs text-[var(--text-3)]">
                  {metrics ? "No recent campaigns with calls in the last 30 days." : "Loading…"}
                </td></tr>
              ) : recent.map((c) => (
                <tr key={c.id} className="border-b border-[var(--border)] last:border-b-0">
                  <td className="py-3">
                    <Link href={`/campaigns/v2/${c.id}`} className="font-medium text-[var(--text-1)] hover:text-blue-400">
                      {c.name}
                      <div className="text-[11px] text-[var(--text-3)] font-mono mt-0.5">
                        {c.timezone}{c.vapi_assistant_name && ` · ${c.vapi_assistant_name}`}
                      </div>
                    </Link>
                  </td>
                  <td className="py-3 text-right font-mono text-[var(--text-2)]">{c.total_calls_30d.toLocaleString()}</td>
                  <td className="py-3 text-right font-mono text-emerald-400">{(c.connect_rate_30d * 100).toFixed(1)}%</td>
                  <td className="py-3 text-right font-mono text-amber-400">{(c.success_rate_30d * 100).toFixed(1)}%</td>
                  <td className="py-3"><StatusPill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Active Workers" sub="Live pool state" action={<Link href="/workers" className="text-xs text-blue-400 px-2 py-1 rounded hover:bg-[var(--bg-elevated)]">Open pool →</Link>}>
          <div className="flex flex-col">
            {slots.length === 0 ? (
              <p className="py-8 text-center text-xs text-[var(--text-3)]">No worker data.</p>
            ) : slots.map(s => (
              <WorkerLine key={s.slotIndex} s={s} now={now} />
            ))}
          </div>
        </Card>
      </div>

      {/* Row 2: Live Activity — two columns: Phones Called + Messages Sent */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card
          title="Phones Called"
          sub="Most recent call events across all campaigns"
          action={<Link href="/activity" className="text-xs text-blue-400 px-2 py-1 rounded hover:bg-[var(--bg-elevated)]">View all →</Link>}
        >
          <div className="flex flex-col">
            {activityCalls === null ? (
              <p className="py-6 text-center text-xs text-[var(--text-3)]">Loading…</p>
            ) : activityCalls.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--text-3)]">No calls in the last 24 hours.</p>
            ) : (
              activityCalls.map((c) => <ActivityLine key={c.id} c={c} now={now} />)
            )}
          </div>
        </Card>

        <Card
          title="Messages Sent"
          sub="Recent SMS sends across all campaigns"
          action={<Link href="/activity" className="text-xs text-blue-400 px-2 py-1 rounded hover:bg-[var(--bg-elevated)]">View all →</Link>}
        >
          <div className="flex flex-col">
            {activitySms === null ? (
              <p className="py-6 text-center text-xs text-[var(--text-3)]">Loading…</p>
            ) : activitySms.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--text-3)]">No SMS sent in the last 24 hours.</p>
            ) : (
              activitySms.map((s) => <SmsLine key={s.id} s={s} now={now} />)
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Compact activity line (used in the dashboard Live Activity widget)
// ─────────────────────────────────────────────────────────────────────────

function ActivityLine({ c, now }: { c: ActivityCall; now: Date }) {
  const tone = callStatusTone(c.status);
  // formatDur takes milliseconds; durationSeconds is in seconds — convert.
  const dur = c.durationSeconds != null ? formatDur(c.durationSeconds * 1000) : null;
  return (
    <Link
      href={`/campaigns/v2/${c.campaignId}`}
      className="flex items-center gap-3 py-2.5 border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition px-2 -mx-2 rounded-md"
    >
      <div className={`w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 ${tone.bg} ${tone.text}`}>
        <CallStatusIcon status={c.status} size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium text-[var(--text-1)]">{c.phoneE164 || "—"}</span>
          <span className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border ${tone.bg} ${tone.text} ${tone.border}`}>
            {c.status.replace(/_/g, " ")}
          </span>
          {c.goalReached && (
            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
              <Target size={9} /> goal
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--text-3)] mt-0.5 truncate">{c.campaignName}</div>
      </div>
      <div className="text-right flex-shrink-0">
        {dur && <div className="font-mono text-[11px] text-[var(--text-2)] tabular-nums">{dur}</div>}
        <div className="font-mono text-[10px] text-[var(--text-3)] mt-0.5">{formatRelativeSync(c.createdAt, now)}</div>
      </div>
    </Link>
  );
}

interface CallTone { bg: string; text: string; border: string; }

function callStatusTone(status: string): CallTone {
  switch (status) {
    case "answered":
    case "completed":
      return { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/30" };
    case "in_progress":
      return { bg: "bg-cyan-500/15", text: "text-cyan-400", border: "border-cyan-500/30" };
    case "ringing":
    case "initiated":
      return { bg: "bg-sky-500/15", text: "text-sky-400", border: "border-sky-500/30" };
    case "no_answer":
    case "busy":
      return { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/30" };
    case "voicemail":
      return { bg: "bg-violet-500/15", text: "text-violet-400", border: "border-violet-500/30" };
    case "failed":
      return { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30" };
    case "canceled":
      return { bg: "bg-[var(--bg-elevated)]", text: "text-[var(--text-3)]", border: "border-[var(--border)]" };
    default:
      return { bg: "bg-[var(--bg-elevated)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
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

function SmsLine({ s, now }: { s: ActivitySms; now: Date }) {
  const tone = smsStatusTone(s.status);
  return (
    <Link
      href={`/campaigns/v2/${s.campaignId}`}
      className="flex items-center gap-3 py-2.5 border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition px-2 -mx-2 rounded-md"
    >
      <div className={`w-8 h-8 rounded-lg grid place-items-center flex-shrink-0 ${tone.bg} ${tone.text}`}>
        <MessageSquare size={13} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-sm font-medium text-[var(--text-1)]">{s.toPhoneE164}</span>
          <span className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border ${tone.bg} ${tone.text} ${tone.border}`}>
            {s.status}
          </span>
        </div>
        <div className="text-[11px] text-[var(--text-2)] mt-0.5 line-clamp-1">{s.bodyPreview}</div>
        {s.errorMessage && (
          <div className="text-[10px] text-red-400 mt-0.5 inline-flex items-center gap-1">
            <AlertCircle size={9} /> {s.errorMessage}
          </div>
        )}
        <div className="text-[10px] text-[var(--text-3)] mt-0.5 truncate">{s.campaignName}</div>
      </div>
      <div className="font-mono text-[10px] text-[var(--text-3)] flex-shrink-0">
        {formatRelativeSync(s.createdAt, now)}
      </div>
    </Link>
  );
}

function smsStatusTone(status: string): CallTone {
  switch (status) {
    case "delivered":
      return { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/30" };
    case "sent":
      return { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/30" };
    case "queued":
      return { bg: "bg-[var(--bg-elevated)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
    case "failed":
    case "undelivered":
      return { bg: "bg-red-500/15", text: "text-red-400", border: "border-red-500/30" };
    default:
      return { bg: "bg-[var(--bg-elevated)]", text: "text-[var(--text-2)]", border: "border-[var(--border)]" };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Hero-chart path builder
// ─────────────────────────────────────────────────────────────────────────
const CHART_W = 1200;
const CHART_H = 220;
const CHART_PAD_Y = 20;

function buildHeroPaths(series: SeriesPoint[]): {
  callsArea: string; callsLine: string; goalsArea: string; goalsLine: string;
} {
  if (series.length < 2) return { callsArea: "", callsLine: "", goalsArea: "", goalsLine: "" };

  const maxVal = Math.max(1, ...series.map(p => Math.max(p.calls, p.goals)));
  const n = series.length;

  const project = (i: number, v: number): [number, number] => {
    const x = (i / (n - 1)) * CHART_W;
    const y = CHART_H - CHART_PAD_Y - (v / maxVal) * (CHART_H - 2 * CHART_PAD_Y);
    return [x, y];
  };

  const makeLine = (key: "calls" | "goals"): string => {
    const pts = series.map((p, i) => project(i, p[key]));
    return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  };

  const makeArea = (key: "calls" | "goals"): string => {
    const pts = series.map((p, i) => project(i, p[key]));
    const top = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    const last = pts[pts.length - 1];
    const first = pts[0];
    return `${top} L ${last[0].toFixed(1)} ${CHART_H} L ${first[0].toFixed(1)} ${CHART_H} Z`;
  };

  return {
    callsArea: makeArea("calls"),
    callsLine: makeLine("calls"),
    goalsArea: makeArea("goals"),
    goalsLine: makeLine("goals"),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function StatCard({
  label, value, delta, deltaColor = "text-emerald-400", icon, sparkColor, bars,
}: {
  label: string; value: string; delta: string; deltaColor?: string;
  icon: React.ReactNode; sparkColor?: string; bars?: boolean;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl px-5 py-4 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/20">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium text-[var(--text-3)]">
        <span className="opacity-70">{icon}</span>
        {label}
      </div>
      <div className="text-[26px] font-bold tabular-nums leading-tight mt-1">{value}</div>
      <div className={`text-[11px] mt-0.5 ${deltaColor}`}>{delta}</div>
      <svg width="100%" height="38" viewBox="0 0 200 38" preserveAspectRatio="none" className="mt-2 opacity-80">
        {bars ? (
          <g fill="#4f8df8">
            <rect x="2"   y="14" width="22" height="22" rx="2" />
            <rect x="28"  y="20" width="22" height="16" rx="2" opacity="0.7" />
            <rect x="54"  y="10" width="22" height="26" rx="2" />
            <rect x="80"  y="16" width="22" height="20" rx="2" opacity="0.7" />
            <rect x="106" y="8"  width="22" height="28" rx="2" />
            <rect x="132" y="14" width="22" height="22" rx="2" opacity="0.7" />
            <rect x="158" y="6"  width="22" height="30" rx="2" />
          </g>
        ) : (
          <polyline points="0,28 28,22 56,26 84,16 112,18 140,12 168,14 200,8" fill="none" stroke={sparkColor} strokeWidth="1.8" />
        )}
      </svg>
    </div>
  );
}

function Card({
  title, sub, action, children,
}: { title: string; sub: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-[15px] font-semibold">{title}</div>
          <div className="text-xs text-[var(--text-3)] mt-1">{sub}</div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ status }: { status: string }) {
  const s = (["running", "paused", "completed", "draft", "archived", "inactive", "skipped"].includes(status)
    ? status
    : "inactive") as "running" | "paused" | "completed" | "draft" | "archived" | "inactive" | "skipped";
  const c = {
    running:   "bg-emerald-500/12 text-emerald-400 border-emerald-500/30",
    paused:    "bg-amber-500/12 text-amber-400 border-amber-500/30",
    completed: "bg-blue-500/12 text-blue-400 border-blue-500/30",
    draft:     "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]",
    archived:  "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
    inactive:  "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
    skipped:   "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
  }[s];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold font-mono border ${c}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${s === "running" ? "animate-pulse" : ""}`} />
      {s}
    </span>
  );
}

function Th({ children, alignRight }: { children: React.ReactNode; alignRight?: boolean }) {
  return (
    <th className={`pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] border-b border-[var(--border)] ${alignRight ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function WorkerLine({ s, now }: { s: PoolSlot; now: Date }) {
  const isOnCall = s.status === "leased" && !!s.inFlightCall;
  const isIdle   = s.status === "leased" && !s.inFlightCall;
  const isMaint  = s.status === "maintenance";

  const tone =
    isOnCall ? "bg-blue-500/15 text-blue-400" :
    isIdle   ? "bg-amber-500/15 text-amber-400" :
    isMaint  ? "bg-red-500/15 text-red-400" :
              "bg-[var(--bg-elevated)] text-[var(--text-3)]";
  const Icon = isOnCall ? PhoneCall : isIdle ? Radio : isMaint ? Wrench : CheckCircle2;

  const city = s.campaign ? s.campaign.timezone.split("/").pop()?.replace(/_/g, " ") : null;
  const localTime = s.campaign
    ? new Intl.DateTimeFormat("en-US", { timeZone: s.campaign.timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(now)
    : null;
  const callDur = s.inFlightCall ? formatDur(s.inFlightCall.durationMs) : null;

  return (
    // P4: clickable row -> /workers?focus=<slot>. The workers landing reads
    // the param and pans the globe to the worker's pin via the pan-to-pin
    // effect in Globe.tsx. Hover bg signals affordance without disrupting
    // the existing border-b divider rhythm.
    <Link
      href={`/workers?focus=${s.slotIndex}`}
      className="flex items-center gap-3 py-2.5 border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors"
    >
      <div className={`w-8 h-8 rounded-lg grid place-items-center ${tone}`}>
        <Icon size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">Worker {s.slotIndex}</div>
        <div className="text-[11px] text-[var(--text-3)] mt-0.5 flex items-center gap-1.5">
          {isOnCall && city && s.inFlightCall ? <><MapPin size={10} /> {city} · on call to {s.inFlightCall.phoneE164}</> :
           isIdle && city                       ? <><MapPin size={10} /> {city} · idle · leased {formatDur(s.leasedDurationMs ?? 0)}</> :
           isMaint                              ? <>Maintenance · {s.notes ?? "manual intervention"}</> :
                                                 <>Free · released</>}
        </div>
      </div>
      <div className={`font-mono text-[11px] flex-shrink-0 ${isOnCall ? "text-blue-400" : "text-[var(--text-3)]"}`}>
        {callDur ?? localTime ?? "—"}
      </div>
    </Link>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function formatDur(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatDeltaPp(delta: number): string {
  const pp = delta * 100;
  if (Math.abs(pp) < 0.05) return "no change · last 7d";
  return `${pp >= 0 ? "+" : ""}${pp.toFixed(1)}pp · last 7d`;
}

function formatRelativeSync(iso: string, now: Date): string {
  const ageSec = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  return `${Math.floor(ageSec / 3600)}h ago`;
}
