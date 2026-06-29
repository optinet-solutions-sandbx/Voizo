"use client";

// Unified Voizo Dashboard (Val's spec, 2026-06-15). Rendered at BOTH /dashboard (the home,
// promoted 2026-06-15) and /analytics — thin page wrappers re-export this component.
// Always-live "Today's Performance" (NEVER filtered) + Global Performance (filters → KPIs,
// tables, leaderboard, charts, heatmap). Reuses the app's card/theme/animated-icon language.
// Today's Performance is the 3-card redesign (Val's mockup 2026-06-29) — see TodayPerformanceCards.

import { useCallback, useEffect, useState } from "react";
import { RefreshCWIcon } from "@/components/icons/animated/refresh-cw";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";
import type {
  TodaySnapshot,
  RateRow,
  RunningCampaignCard as RunningCard,
} from "@/lib/dashboardAnalytics";
import GlobalPerformance, { type Filters, DEFAULTS } from "./GlobalPerformance";
import MetricDrawer, { type MetricKey } from "./MetricDrawer";
import CampaignDetailsModal from "./CampaignDetailsModal";
import TodayPerformanceCards from "./TodayPerformanceCards";
import { useMagnetic } from "@/components/useMagnetic";
import { formatCampaign } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { useBaseAgentNames } from "./useBaseAgentNames";

const POLL_MS = 30_000;

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

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
      {statCell(pct(rate.positiveResponseRate), "Positive", "text-amber-400")}
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

export default function DashboardView() {
  const [data, setData] = useState<TodaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Global Performance filters live here (lifted 2026-06-16) so a running card AND the leaderboard
  // can both "Filter dashboard to this campaign" through one state.
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const [detailFor, setDetailFor] = useState<RunningCard | null>(null);
  const [drawerMetric, setDrawerMetric] = useState<MetricKey | null>(null);
  // Dev preview: ?date=YYYY-MM-DD on the page URL renders that day as "today" (forwarded to the API).
  const [previewDate] = useState<string | null>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("date") : null,
  );

  const focusCampaign = useCallback((id: string) => {
    setFilters((f) => ({ ...f, campaignIds: [id] }));
    document.getElementById("global-performance")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const url = previewDate
        ? `/api/dashboard/today?date=${encodeURIComponent(previewDate)}`
        : "/api/dashboard/today";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as TodaySnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setRefreshing(false);
    }
  }, [previewDate]);

  useEffect(() => {
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

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

      {/* Today's Performance — 3-card redesign (Val's mockup 2026-06-29): Call Attempts / Reached /
          SMS Sent, Today/Yesterday toggle, dual deltas, and click-anything → inline records drawer. */}
      <TodayPerformanceCards data={data} previewDate={previewDate} />

      {data && data.runningCampaigns.length === 0 && (
        <p className="text-center text-xs text-[var(--text-3)] py-1">No campaigns are running right now.</p>
      )}

      {/* Global Performance — filters + KPI grid → charts → campaign table → heatmap → ranked tables.
          (Charts/heatmap/ranked tables share GlobalPerformance's fetched data, so the section owns the
          full ordered flow; the campaign table is self-contained and slotted into that order.) */}
      <GlobalPerformance filters={filters} onChange={setFilters} onFocusCampaign={focusCampaign} onMetricClick={setDrawerMetric} />
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

      <MetricDrawer metric={drawerMetric} onClose={() => setDrawerMetric(null)} />
    </>
  );
}
