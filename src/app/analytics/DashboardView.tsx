"use client";

// Unified Voizo Dashboard (Val's spec, 2026-06-15). Rendered at BOTH /dashboard (the home,
// promoted 2026-06-15) and /analytics — thin page wrappers re-export this component.
// Always-live "Today's Performance" (NEVER filtered) + Global Performance (filters → KPIs,
// tables, leaderboard, charts, heatmap). Reuses the app's card/theme/animated-icon language.
// Connect = ANSWER (incl. voicemail); Success% = goal_reached / connected. Ghost + test excluded.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PhoneCall, Zap, MessageSquare, Radio } from "lucide-react";
import { RefreshCWIcon } from "@/components/icons/animated/refresh-cw";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";
import type {
  TodaySnapshot,
  RateRow,
  RunningCampaignCard as RunningCard,
} from "@/lib/dashboardAnalytics";
import GlobalPerformance, { type Filters, DEFAULTS } from "./GlobalPerformance";
import CampaignDetailsModal from "./CampaignDetailsModal";
import { useMagnetic } from "@/components/useMagnetic";
import { formatCampaign } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { useBaseAgentNames } from "./useBaseAgentNames";

const POLL_MS = 30_000;

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

function fmtDelta(frac: number | null, suffix: string): { text: string; color: string } {
  if (frac === null) return { text: `no baseline · ${suffix}`, color: "text-[var(--text-3)]" };
  const p = frac * 100;
  const up = p >= 0;
  return {
    text: `${up ? "▲" : "▼"} ${Math.abs(p).toFixed(1)}% ${suffix}`,
    color: up ? "text-emerald-400" : "text-red-400",
  };
}

// "2026-06-15" -> "15 Jun 2026" (manual, locale-independent — avoids hydration drift).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

function statCell(value: string, label: string, color: string) {
  return (
    <div>
      <div className={`text-lg font-bold font-mono ${color}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mt-0.5">{label}</div>
    </div>
  );
}

function StatTriple({ rate }: { rate: RateRow }) {
  return (
    <div className="grid grid-cols-3 gap-2 mt-3">
      {statCell(rate.calls.toLocaleString(), "Calls", "text-[var(--text-1)]")}
      {statCell(pct(rate.connectRate), "Connect", "text-emerald-400")}
      {statCell(pct(rate.successRate), "Success", "text-amber-400")}
    </div>
  );
}

function RunningCampaignCardView({ c, onOpen }: { c: RunningCard; onOpen: () => void }) {
  const fmt = formatCampaign(c.name);
  const baseAgentName = useBaseAgentNames();
  const magnetRef = useMagnetic<HTMLButtonElement>();
  return (
    <button
      type="button"
      ref={magnetRef}
      onClick={onOpen}
      title="View campaign details & prompt"
      className="glow-card w-full text-left bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 cursor-pointer transition-colors hover:border-[var(--border-2)] focus:outline-none focus:ring-2 focus:ring-blue-500/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {c.country !== "UNKNOWN" && (
              <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)] shrink-0">
                {c.country}
              </span>
            )}
            <span className="text-sm font-semibold text-[var(--text-1)] truncate" title={c.name}>
              {fmt.offer || fmt.display}
            </span>
          </div>
          <div className="text-[11px] text-[var(--text-3)] mt-1 truncate">
            {baseAgentName(c.baseAssistantId) ?? voiceName(c.voiceId, { short: true }) ?? "—"}
          </div>
        </div>
        <span className="inline-flex items-center gap-1 text-[9px] font-semibold text-emerald-400 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> LIVE
        </span>
      </div>
      <StatTriple rate={c.today} />
    </button>
  );
}

function OpsCell({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  const magnetRef = useMagnetic<HTMLDivElement>();
  return (
    <div
      ref={magnetRef}
      className="glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4"
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

export default function DashboardView() {
  const [data, setData] = useState<TodaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Global Performance filters live here (lifted 2026-06-16) so a running card AND the leaderboard
  // can both "Filter dashboard to this campaign" through one state.
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [detailFor, setDetailFor] = useState<RunningCard | null>(null);

  const focusCampaign = useCallback((id: string) => {
    setFilters((f) => ({ ...f, campaignIds: [id] }));
    document.getElementById("global-performance")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/dashboard/today", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as TodaySnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const ops = data?.ops;
  const d1 = ops ? fmtDelta(ops.deltaVsYesterday, "vs yesterday") : null;
  const d2 = ops
    ? fmtDelta(ops.deltaVsSevenDayAvg, `vs last 7-day avg (${Math.round(ops.sevenDayAvg).toLocaleString()})`)
    : null;

  return (
    <>
      {/* Background dot-field is now global (rendered once in the app layout). */}
      <div className="p-6 max-w-[1400px] mx-auto w-full grid gap-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-[26px] font-bold tracking-tight">Today&apos;s Performance</h1>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE{data ? ` · ${fmtDay(data.dayUtc)}` : ""}
            </span>
          </div>
          <p className="text-sm text-[var(--text-3)] mt-1">
            Live operational snapshot — never affected by the filters below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
          <button
            onClick={load}
            disabled={refreshing}
            title="Refresh"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <HoverIcon icon={RefreshCWIcon} size={12} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Running campaign cards — hidden entirely when none are running (Val's spec). */}
      {data && data.runningCampaigns.length > 0 && (
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3.5">
          {data.runningCampaigns.map((c) => (
            <RunningCampaignCardView key={c.id} c={c} onOpen={() => setDetailFor(c)} />
          ))}
        </section>
      )}

      {/* Ops strip (4 cells). */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <OpsCell icon={<PhoneCall size={12} />} label="Calls Today">
          <div className="text-3xl font-bold font-mono text-[var(--text-1)] mt-2">
            {(ops?.callsToday ?? 0).toLocaleString()}
          </div>
          {d1 && d2 && (
            <div className="mt-2 space-y-0.5">
              <div className={`text-[11px] ${d1.color}`}>{d1.text}</div>
              <div className={`text-[11px] ${d2.color}`}>{d2.text}</div>
            </div>
          )}
        </OpsCell>

        <OpsCell icon={<Zap size={12} />} label="Connect Rate Today">
          <div className="text-3xl font-bold font-mono text-emerald-400 mt-2">{pct(ops?.connectRateToday ?? null)}</div>
          <div
            className="text-[11px] text-[var(--text-3)] mt-2"
            title="Connect = answered, including voicemail. Human-only ‘Reach’ is a later slice."
          >
            {ops
              ? `${ops.connectedToday.toLocaleString()} of ${ops.terminalToday.toLocaleString()} calls connected`
              : "—"}
          </div>
        </OpsCell>

        <OpsCell icon={<MessageSquare size={12} />} label="Messages Sent Today">
          <div className="text-3xl font-bold font-mono text-[var(--text-1)] mt-2">
            {(ops?.messagesSentToday ?? 0).toLocaleString()}
          </div>
          {ops && (
            <div className="mt-2 space-y-0.5 text-[11px] text-[var(--text-3)]">
              <div>
                <span className="text-[var(--text-2)] font-medium">{pct(ops.messagesShareOfCalls)}</span> of today&apos;s calls
              </div>
              <div>
                <span className="text-[var(--text-2)] font-medium">{pct(ops.messagesShareOfConnected)}</span> of connected calls
              </div>
            </div>
          )}
        </OpsCell>

        <OpsCell icon={<Radio size={12} />} label="Active AI Agents">
          <div className="text-3xl font-bold font-mono text-[var(--text-1)] mt-2">
            {ops?.activeAgents ?? 0} <span className="text-[var(--text-3)]">/ {ops?.totalAgents ?? 0}</span>
          </div>
          <div className="text-[11px] text-[var(--text-3)] mt-2">
            {ops
              ? `${ops.idleAgents} idle · ${ops.runningCampaignCount} campaign${ops.runningCampaignCount === 1 ? "" : "s"} running`
              : "—"}
          </div>
        </OpsCell>
      </section>

      {/* States */}
      {!data && !error && <p className="text-center text-xs text-[var(--text-3)] py-8">Loading today&apos;s performance…</p>}
      {data && data.runningCampaigns.length === 0 && (
        <p className="text-center text-xs text-[var(--text-3)] py-1">No campaigns are running right now.</p>
      )}

      {/* Global Performance — filters + KPI grid → charts → campaign table → heatmap → ranked tables.
          (Charts/heatmap/ranked tables share GlobalPerformance's fetched data, so the section owns the
          full ordered flow; the campaign table is self-contained and slotted into that order.) */}
      <GlobalPerformance filters={filters} onChange={setFilters} onFocusCampaign={focusCampaign} />
      </div>

      {detailFor && (
        <CampaignDetailsModal
          campaignId={detailFor.id}
          name={detailFor.name}
          country={detailFor.country}
          status="running"
          baseAssistantId={detailFor.baseAssistantId}
          metrics={detailFor.today}
          metricsLabel="Today"
          onClose={() => setDetailFor(null)}
          onFilter={() => focusCampaign(detailFor.id)}
        />
      )}
    </>
  );
}
