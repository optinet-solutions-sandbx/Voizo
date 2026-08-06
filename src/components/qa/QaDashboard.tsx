"use client";

// QaDashboard — TEMPORARY QA analysis dashboard. Read-only roll-up of the QA
// prompt-analysis results (listener_qa_analysis_runs) via /api/qa-prompt-testing/
// dashboard. Follows the campaigns dashboard's shape (KPI band + breakdown card +
// per-campaign table) but is fully isolated from it — it never reads calls_v2 /
// the SQL rollups, so it can't affect the campaigns dashboard.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, BarChart3, ClipboardList } from "lucide-react";
import { SectionTick } from "../../app/analytics/SectionIsland";
import StatBand from "../../app/analytics/StatBand";
import WidgetCard from "../../app/analytics/WidgetCard";
import Pagination from "@/components/Pagination";

interface Campaign {
  campaignId: string;
  campaignName: string | null;
  total: number;
  callAttempt: Record<string, number>;
  reachedCategory: Record<string, number>;
}
interface DashData {
  total: number;
  unparseable: number;
  byCallAttempt: Record<string, number>;
  byReachedCategory: Record<string, number>;
  campaigns: Campaign[];
  sinceIso: string | null;
}

const PAGE_SIZE = 15;
const RC_ORDER = ["Positive", "Neutral", "Declined", "Early Hang-up", "Agent Timeout"];
const RC_COLOR: Record<string, string> = {
  Positive: "#3ec08a",
  Neutral: "#5b9bf0",
  Declined: "#e46664",
  "Early Hang-up": "#e0814a",
  "Agent Timeout": "#c264d6",
};
const n = (o: Record<string, number>, k: string) => o[k] ?? 0;

export default function QaDashboard() {
  const [days, setDays] = useState<0 | 7 | 30>(0); // 0 = all
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/qa-prompt-testing/dashboard${days ? `?days=${days}` : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as DashData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load QA dashboard");
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const reachedTotal = useMemo(
    () => (data ? Object.values(data.byReachedCategory).reduce((s, v) => s + v, 0) : 0),
    [data],
  );
  const rcKeys = useMemo(() => {
    if (!data) return [];
    const extra = Object.keys(data.byReachedCategory).filter((k) => !RC_ORDER.includes(k));
    return [...RC_ORDER.filter((k) => k in data.byReachedCategory), ...extra];
  }, [data]);

  const totalPages = Math.max(1, Math.ceil((data?.campaigns.length ?? 0) / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageCampaigns = useMemo(
    () => (data?.campaigns ?? []).slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [data, safePage],
  );

  const dayCls = (on: boolean) =>
    `px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap ${
      on ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
    }`;

  return (
    <div className="grid gap-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <SectionTick color="#a78bfa" />
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">QA Analysis Dashboard</h1>
          </div>
          <p className="mt-1 text-xs text-[var(--text-3)]">
            Rolled up from your prompt analyses (temporary) — separate from the campaigns Dashboard, which tracks call
            outcomes.
          </p>
        </div>
        <div className="inline-flex gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
          <button onClick={() => { setDays(0); setPage(1); }} className={dayCls(days === 0)}>All</button>
          <button onClick={() => { setDays(7); setPage(1); }} className={dayCls(days === 7)}>7d</button>
          <button onClick={() => { setDays(30); setPage(1); }} className={dayCls(days === 30)}>30d</button>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3">
          <div className="h-24 rounded-[14px] bg-[var(--bg-elevated)] animate-pulse" />
          <div className="h-40 rounded-xl bg-[var(--bg-elevated)] animate-pulse" />
        </div>
      ) : error ? (
        <p className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
          <AlertCircle size={11} /> {error}
        </p>
      ) : !data || data.total === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">
          No analysis results yet{days ? " in this window" : ""}. Run a Bulk analysis to populate this.
        </div>
      ) : (
        <>
          {/* KPI band — call_attempt dispositions (+ Agent Timeout from reached_category, the go-live signal) */}
          <StatBand
            stats={[
              { label: "Analyzed", value: data.total },
              { label: "Reached", value: n(data.byCallAttempt, "Reached"), accent: "#3ec08a" },
              { label: "Voicemail", value: n(data.byCallAttempt, "Voicemail"), accent: "#8f86e6" },
              { label: "Unreachable", value: n(data.byCallAttempt, "Unreachable"), accent: "#e0a53c" },
              { label: "Agent Timeout", value: n(data.byReachedCategory, "Agent Timeout"), accent: "#c264d6", sub: "of reached" },
            ]}
          />

          {/* Reached — outcome breakdown (reached_category) */}
          <WidgetCard title="Reached — outcome breakdown" icon={<BarChart3 size={14} className="text-primary" />} context={`${reachedTotal.toLocaleString()} reached`}>
            {rcKeys.length === 0 ? (
              <p className="text-xs text-[var(--text-3)]">No reached calls in this window.</p>
            ) : (
              <div className="grid gap-2">
                {rcKeys.map((k) => {
                  const v = n(data.byReachedCategory, k);
                  const pct = reachedTotal ? Math.round((v / reachedTotal) * 100) : 0;
                  return (
                    <div key={k} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 text-xs text-[var(--text-2)]">{k}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: RC_COLOR[k] ?? "#7d828c" }} />
                      </div>
                      <span className="w-24 shrink-0 text-right text-xs font-mono text-[var(--text-1)]">
                        {v.toLocaleString()} <span className="text-[var(--text-3)]">· {pct}%</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </WidgetCard>

          {/* Per-campaign table */}
          <WidgetCard
            title="By campaign"
            icon={<ClipboardList size={14} className="text-blue-400" />}
            context={`${data.campaigns.length} campaign${data.campaigns.length === 1 ? "" : "s"}`}
            bodyClassName="p-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-[var(--text-3)]">
                    <th className="text-left font-semibold px-4 py-2">Campaign</th>
                    <th className="text-right font-semibold px-3 py-2">Analyzed</th>
                    <th className="text-right font-semibold px-3 py-2">Reached</th>
                    <th className="text-right font-semibold px-3 py-2">Voicemail</th>
                    <th className="text-right font-semibold px-3 py-2" style={{ color: "#c264d6" }}>Agent Timeout</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {pageCampaigns.map((c) => (
                    <tr key={c.campaignId} className="hover:bg-[var(--bg-hover)] transition">
                      <td className="px-4 py-2 text-[var(--text-1)] max-w-[420px] truncate">{c.campaignName ?? c.campaignId.slice(0, 8)}</td>
                      <td className="px-3 py-2 text-right font-mono text-[var(--text-1)]">{c.total.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-400">{n(c.callAttempt, "Reached").toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono text-[var(--text-2)]">{n(c.callAttempt, "Voicemail").toLocaleString()}</td>
                      <td className="px-3 py-2 text-right font-mono" style={{ color: n(c.reachedCategory, "Agent Timeout") > 0 ? "#c264d6" : "var(--text-3)" }}>
                        {n(c.reachedCategory, "Agent Timeout").toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </WidgetCard>

          <Pagination
            currentPage={safePage}
            totalPages={totalPages}
            totalItems={data.campaigns.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />

          {data.unparseable > 0 && (
            <p className="text-[10px] text-[var(--text-3)]">
              {data.unparseable} result{data.unparseable === 1 ? "" : "s"} couldn&rsquo;t be parsed as JSON (excluded from the breakdown).
            </p>
          )}
        </>
      )}
    </div>
  );
}
