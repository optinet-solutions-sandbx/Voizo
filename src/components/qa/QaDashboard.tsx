"use client";

// QaDashboard — TEMPORARY QA analysis dashboard. Read-only roll-up of the QA
// prompt-analysis results (listener_qa_analysis_runs), mirroring the campaigns
// dashboard: Today / Yesterday / date-range filter, KPI totals, an outcome
// breakdown, and a per-campaign table — every total/cell is clickable and opens a
// records drawer (the runs behind that number). Fully isolated from the campaigns
// dashboard (never reads calls_v2 / the SQL rollups).

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, BarChart3, ClipboardList } from "lucide-react";
import { SectionTick } from "../../app/analytics/SectionIsland";
import WidgetCard from "../../app/analytics/WidgetCard";
import Pagination from "@/components/Pagination";
import QaRecordsDrawer, { type DrawerSlice } from "./QaRecordsDrawer";

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
}

type Period = "today" | "yesterday" | "7d" | "30d" | "all";
const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
];
const PAGE_SIZE = 15;
const RC_ORDER = ["Positive", "Neutral", "Declined", "Early Hang-up", "Agent Timeout"];
const RC_COLOR: Record<string, string> = {
  Positive: "#3ec08a", Neutral: "#5b9bf0", Declined: "#e46664", "Early Hang-up": "#e0814a", "Agent Timeout": "#c264d6",
};
const n = (o: Record<string, number>, k: string) => o[k] ?? 0;

// Date window (browser-local) by call date — matches how the campaigns dashboard scopes Today/Yesterday.
function windowFor(p: Period): { fromMs: number | null; toMs: number | null } {
  const now = Date.now();
  const d = new Date();
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (p) {
    case "today": return { fromMs: midnight, toMs: null };
    case "yesterday": return { fromMs: midnight - 86_400_000, toMs: midnight };
    case "7d": return { fromMs: now - 7 * 86_400_000, toMs: null };
    case "30d": return { fromMs: now - 30 * 86_400_000, toMs: null };
    default: return { fromMs: null, toMs: null };
  }
}

function KpiCard({ label, value, accent, sub, onClick }: { label: string; value: number; accent?: string; sub?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-left bg-[#12141a] px-[18px] py-[15px] min-w-0 hover:bg-[var(--bg-hover)] transition" title="Click to see these calls">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)] whitespace-nowrap truncate">{label}</div>
      <div className="text-[27px] leading-[1.1] font-semibold font-mono tracking-[-0.02em] mt-1.5" style={{ color: accent ?? "var(--text-1)" }}>
        {value.toLocaleString()}
      </div>
      <div className="text-[11px] text-[var(--text-4)] mt-0.5 h-[14px] whitespace-nowrap truncate">{sub ?? ""}</div>
    </button>
  );
}

export default function QaDashboard() {
  const [period, setPeriod] = useState<Period>("all");
  const win = useMemo(() => windowFor(period), [period]);
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [slice, setSlice] = useState<DrawerSlice | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (win.fromMs != null) p.set("fromMs", String(win.fromMs));
      if (win.toMs != null) p.set("toMs", String(win.toMs));
      const qs = p.toString();
      const r = await fetch(`/api/qa-prompt-testing/dashboard${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as DashData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load QA dashboard");
    } finally {
      setLoading(false);
    }
  }, [win]);

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

  // A drawer slice always carries the current window (set by the component via props).
  const open = (s: DrawerSlice) => setSlice(s);
  const cellBtn = "hover:underline cursor-pointer";

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
            From your prompt analyses (temporary) — separate from the campaigns Dashboard. Click any total to see the calls behind it.
          </p>
        </div>
        <div className="inline-flex gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => { setPeriod(p.key); setPage(1); }} className={dayCls(period === p.key)}>{p.label}</button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3">
          <div className="h-24 rounded-[14px] bg-[var(--bg-elevated)] animate-pulse" />
          <div className="h-40 rounded-xl bg-[var(--bg-elevated)] animate-pulse" />
        </div>
      ) : error ? (
        <p className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1"><AlertCircle size={11} /> {error}</p>
      ) : !data || data.total === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">No analysis results in this period.</div>
      ) : (
        <>
          {/* KPI band — clickable */}
          <div className="grid gap-px bg-[var(--border)] border border-[var(--border)] rounded-[14px] overflow-hidden" style={{ gridTemplateColumns: "repeat(5,minmax(0,1fr))" }}>
            <KpiCard label="Analyzed" value={data.total} onClick={() => open({ title: "All analyzed calls" })} />
            <KpiCard label="Reached" value={n(data.byCallAttempt, "Reached")} accent="#3ec08a" onClick={() => open({ title: "Reached", callAttempt: "Reached" })} />
            <KpiCard label="Voicemail" value={n(data.byCallAttempt, "Voicemail")} accent="#8f86e6" onClick={() => open({ title: "Voicemail", callAttempt: "Voicemail" })} />
            <KpiCard label="Unreachable" value={n(data.byCallAttempt, "Unreachable")} accent="#e0a53c" onClick={() => open({ title: "Unreachable", callAttempt: "Unreachable" })} />
            <KpiCard label="Agent Timeout" value={n(data.byReachedCategory, "Agent Timeout")} accent="#c264d6" sub="of reached" onClick={() => open({ title: "Agent Timeout", reachedCategory: "Agent Timeout" })} />
          </div>

          {/* Reached outcome breakdown — clickable rows */}
          <WidgetCard title="Reached — outcome breakdown" icon={<BarChart3 size={14} className="text-primary" />} context={`${reachedTotal.toLocaleString()} reached`}>
            {rcKeys.length === 0 ? (
              <p className="text-xs text-[var(--text-3)]">No reached calls in this period.</p>
            ) : (
              <div className="grid gap-2">
                {rcKeys.map((k) => {
                  const v = n(data.byReachedCategory, k);
                  const pct = reachedTotal ? Math.round((v / reachedTotal) * 100) : 0;
                  return (
                    <button key={k} onClick={() => open({ title: `Reached · ${k}`, reachedCategory: k })} className="flex items-center gap-3 text-left hover:bg-[var(--bg-hover)] rounded-md px-1 py-0.5 transition">
                      <span className="w-28 shrink-0 text-xs text-[var(--text-2)]">{k}</span>
                      <div className="flex-1 h-2.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: RC_COLOR[k] ?? "#7d828c" }} />
                      </div>
                      <span className="w-24 shrink-0 text-right text-xs font-mono text-[var(--text-1)]">
                        {v.toLocaleString()} <span className="text-[var(--text-3)]">· {pct}%</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </WidgetCard>

          {/* Per-campaign table — clickable cells */}
          <WidgetCard title="By campaign" icon={<ClipboardList size={14} className="text-blue-400" />} context={`${data.campaigns.length} campaign${data.campaigns.length === 1 ? "" : "s"}`} bodyClassName="p-0">
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
                  {pageCampaigns.map((c) => {
                    const at = n(c.reachedCategory, "Agent Timeout");
                    return (
                      <tr key={c.campaignId} className="hover:bg-[var(--bg-hover)] transition">
                        <td className="px-4 py-2 max-w-[380px] truncate">
                          <button onClick={() => open({ title: c.campaignName ?? "Campaign", campaignId: c.campaignId })} className={`text-[var(--text-1)] ${cellBtn}`}>
                            {c.campaignName ?? c.campaignId.slice(0, 8)}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[var(--text-1)]">{c.total.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          <button onClick={() => open({ title: `${c.campaignName ?? "Campaign"} · Reached`, campaignId: c.campaignId, callAttempt: "Reached" })} className={`text-emerald-400 ${cellBtn}`}>
                            {n(c.callAttempt, "Reached").toLocaleString()}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          <button onClick={() => open({ title: `${c.campaignName ?? "Campaign"} · Voicemail`, campaignId: c.campaignId, callAttempt: "Voicemail" })} className={`text-[var(--text-2)] ${cellBtn}`}>
                            {n(c.callAttempt, "Voicemail").toLocaleString()}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          <button
                            onClick={() => open({ title: `${c.campaignName ?? "Campaign"} · Agent Timeout`, campaignId: c.campaignId, reachedCategory: "Agent Timeout" })}
                            className={cellBtn}
                            style={{ color: at > 0 ? "#c264d6" : "var(--text-3)" }}
                          >
                            {at.toLocaleString()}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </WidgetCard>

          <Pagination currentPage={safePage} totalPages={totalPages} totalItems={data.campaigns.length} pageSize={PAGE_SIZE} onPageChange={setPage} />

          {data.unparseable > 0 && (
            <p className="text-[10px] text-[var(--text-3)]">{data.unparseable} result{data.unparseable === 1 ? "" : "s"} couldn&rsquo;t be parsed as JSON (excluded).</p>
          )}
        </>
      )}

      {slice && <QaRecordsDrawer slice={slice} fromMs={win.fromMs} toMs={win.toMs} onClose={() => setSlice(null)} />}
    </div>
  );
}
