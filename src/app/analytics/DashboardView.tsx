"use client";

// Unified Voizo Dashboard (Val's spec, 2026-06-15). Rendered at BOTH /dashboard (the home,
// promoted 2026-06-15) and /analytics — thin page wrappers re-export this component.
// Always-live "Today's Performance" (NEVER filtered) + Global Performance (filters → KPIs,
// tables, leaderboard, charts, heatmap). Reuses the app's card/theme/animated-icon language.
// Today's Performance is the 3-card redesign (Val's mockup 2026-06-29) — see TodayPerformanceCards.

import { useCallback, useEffect, useState } from "react";
import { Radio } from "lucide-react";
import { RefreshCWIcon } from "@/components/icons/animated/refresh-cw";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";
import type { TodaySnapshot } from "@/lib/dashboardAnalytics";
import GlobalPerformance, { type Filters, DEFAULTS } from "./GlobalPerformance";
import TodayPerformanceCards from "./TodayPerformanceCards";
import TodaysCampaigns from "./TodaysCampaigns";
import SectionIsland, { SectionTick } from "./SectionIsland";

const POLL_MS = 30_000;

// "2026-06-15" -> "15 Jun 2026" (manual, locale-independent — avoids hydration drift).
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

export default function DashboardView() {
  const [data, setData] = useState<TodaySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Global Performance filters live here (lifted 2026-06-16) so a running card AND the leaderboard
  // can both "Filter dashboard to this campaign" through one state.
  const [filters, setFilters] = useState<Filters>(DEFAULTS);

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

  return (
    <>
      {/* Background dot-field is now global (rendered once in the app layout). */}
      {/* Centered, capped width — 2026-07-07. Reverts the 2026-07-02 fluid "use the screen"
          layout (cards stretched too wide, Val's meeting note). Val's mockup shell is 900px,
          but the live Campaign Performance table (5 cols) clips at 900, so capped at 1120. */}
      <div className="p-4 w-full max-w-[1120px] mx-auto grid gap-4">
      {/* Today panel — the always-live snapshot, never affected by the filters. Zone is marked
          by the green tick (pattern brief §1), not a background wash. */}
      <SectionIsland>
      {/* Header — title/LIVE on the left; agents-active chip grouped with Refresh top-right
          (mockup parity, Jasiel 2026-07-03). The Today/Yesterday toggle sits alone below (in
          TodayPerformanceCards). items-start so the right group aligns with the title row. */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <SectionTick color="#3ec08a" />
            <h1 className="text-lg font-semibold tracking-tight">Today&apos;s Performance</h1>
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-400 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE{data ? ` · ${fmtDay(data.dayUtc)}` : ""}
            </span>
          </div>
          <p className="text-xs text-[var(--text-3)] mt-0.5">
            Live operational snapshot — never affected by the filters below.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
          {data?.ops && (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-3)] px-2 py-1 rounded-lg border border-[var(--border)]">
              <Radio size={12} className="text-[var(--text-2)]" />
              <span className="font-mono text-[var(--text-1)]">{data.ops.activeAgents}</span>/<span className="font-mono">{data.ops.totalAgents}</span> agents active
            </span>
          )}
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

      {/* Today's Performance — 3-card redesign (Val's mockup 2026-06-29): Call Attempts / Reached /
          SMS Sent, Today/Yesterday toggle, dual deltas, and click-anything → inline records drawer.
          Pinned above the running-campaign rows (Jasiel 2026-07-01) so the headline metrics stay on top. */}
      <TodayPerformanceCards data={data} />

      {/* Today's campaigns — expandable per-campaign rows (Val's mockup, Slice A). Hidden when none running. */}
      {data && data.runningCampaigns.length > 0 && (
        <TodaysCampaigns campaigns={data.runningCampaigns} />
      )}

      {data && data.runningCampaigns.length === 0 && (
        <p className="text-center text-xs text-[var(--text-3)] py-1">No campaigns are running right now.</p>
      )}
      </SectionIsland>

      {/* Global — filtered historical performance. NO panel wrap (reference): tick header +
          sticky filter bar + free-standing modules on the app background. */}
      <GlobalPerformance filters={filters} onChange={setFilters} />
      </div>
    </>
  );
}
