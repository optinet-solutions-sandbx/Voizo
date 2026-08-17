"use client";

// QaDashboard — TEMPORARY QA analysis dashboard. Read-only roll-up of the QA
// prompt-analysis results (listener_qa_analysis_runs), mirroring the campaigns
// dashboard: Today / Yesterday / date-range filter, KPI totals, an outcome
// breakdown, and a per-campaign table — every total/cell is clickable and opens a
// records drawer (the runs behind that number). Fully isolated from the campaigns
// dashboard (never reads calls_v2 / the SQL rollups).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BarChart3, ClipboardList, Download, PhoneOff } from "lucide-react";
import { SectionTick } from "../../app/analytics/SectionIsland";
import WidgetCard from "../../app/analytics/WidgetCard";
import Pagination from "@/components/Pagination";
import QaRecordsDrawer, { type DrawerSlice } from "./QaRecordsDrawer";

interface Campaign {
  campaignId: string;
  campaignName: string | null;
  timezone: string;
  lastAnalyzedAt: string | null;
  total: number;
  callAttempt: Record<string, number>;
  reachedCategory: Record<string, number>;
}
interface DashData {
  total: number;
  unparseable: number;
  doubleChecked: number;
  byCallAttempt: Record<string, number>;
  byReachedCategory: Record<string, number>;
  campaigns: Campaign[];
}

type Period = "today" | "yesterday" | "date" | "7d" | "30d" | "all";
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

// CSV + per-campaign-table column vocabulary (matches the on-screen breakdown).
// Early Hang-up is now a top-level call_attempt (its own category), not a reached sub-outcome.
const CA_COLS = ["Reached", "Voicemail", "Early Hang-up", "Unreachable"]; // call_attempt
const RC_COLS = ["Positive", "Neutral", "Declined", "Agent Timeout"]; // reached_category
const CA_COL_CLS: Record<string, string> = { Reached: "text-emerald-400", Voicemail: "text-[var(--text-2)]", "Early Hang-up": "text-[#e0814a]", Unreachable: "text-[var(--text-2)]" };

// A viewer-local YYYY-MM-DD, offset by `deltaDays` — the reference for the Today/Yesterday buttons.
function localDateStr(deltaDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
// UTC range for the multi-day periods; single-day periods use `day` (campaign-local) instead.
function rangeFor(p: Period): { fromMs: number | null; toMs: number | null } {
  const now = Date.now();
  if (p === "7d") return { fromMs: now - 7 * 86_400_000, toMs: null };
  if (p === "30d") return { fromMs: now - 30 * 86_400_000, toMs: null };
  return { fromMs: null, toMs: null };
}

// ── CSV helpers ────────────────────────────────────────────────────────────────
function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const body = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8;" }); // BOM → Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function stripFences(s: string): string {
  return s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
}
function parseCats(summary: string | null): { callAttempt: string; reachedCategory: string } {
  try {
    const o = JSON.parse(stripFences(summary ?? "")) as Record<string, unknown>;
    return {
      callAttempt: typeof o.call_attempt === "string" ? o.call_attempt : "",
      reachedCategory: typeof o.reached_category === "string" ? o.reached_category : "",
    };
  } catch {
    return { callAttempt: "", reachedCategory: "" };
  }
}
function oneLineSummary(summary: string | null): string {
  if (!summary) return "";
  const c = stripFences(summary);
  try {
    const o = JSON.parse(c) as Record<string, unknown>;
    if (typeof o.summary === "string") return o.summary.replace(/\s+/g, " ");
  } catch { /* not JSON */ }
  return c.replace(/\s+/g, " ");
}
function localDay(iso: string | null, tz: string): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
}
interface RawRun {
  campaignName: string | null;
  campaignTimezone: string;
  customerName: string | null;
  customerPhone: string | null;
  callCreatedAt: string | null;
  durationSeconds: number | null;
  goalReached: boolean | null;
  summary: string | null;
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
  const [period, setPeriod] = useState<Period>("today");
  const [customDate, setCustomDate] = useState<string>(localDateStr());
  const [prompts, setPrompts] = useState<{ id: string; title: string; isActive: boolean }[]>([]);
  const [promptId, setPromptId] = useState<string | "all">("all"); // "all" = latest run per call across prompts
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [slice, setSlice] = useState<DrawerSlice | null>(null);
  const [exporting, setExporting] = useState(false);

  // Scope: a single campaign-local `day` (Today/Yesterday/picked date) OR a UTC range (7d/30d/all).
  const scope = useMemo(() => {
    if (period === "today") return { day: localDateStr(0), fromMs: null as number | null, toMs: null as number | null };
    if (period === "yesterday") return { day: localDateStr(-1), fromMs: null, toMs: null };
    if (period === "date") return { day: customDate, fromMs: null, toMs: null };
    return { day: null as string | null, ...rangeFor(period) };
  }, [period, customDate]);

  const scopeLabel = scope.day
    ? `${scope.day} · each campaign's local day`
    : period === "7d" ? "Last 7 days" : period === "30d" ? "Last 30 days" : "All time";

  // Load the prompt list once; default the filter to the active (default) prompt.
  useEffect(() => {
    fetch("/api/qa-prompt-testing/prompts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = (d?.prompts ?? []) as { id: string; title: string; isActive: boolean }[];
        setPrompts(list);
        const active = list.find((x) => x.isActive);
        if (active) setPromptId(active.id);
      })
      .catch(() => { /* filter just stays on "all" */ });
  }, []);

  // Staleness guard: each load gets a sequence number; a response is applied only
  // if it's still the latest request. Without this, a slow earlier fetch (e.g. the
  // default "all prompts" scan) can resolve AFTER a newer one and clobber it —
  // which made clicking "7 days" snap back to Today.
  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (scope.day) p.set("day", scope.day);
      else {
        if (scope.fromMs != null) p.set("fromMs", String(scope.fromMs));
        if (scope.toMs != null) p.set("toMs", String(scope.toMs));
      }
      if (promptId !== "all") p.set("promptId", promptId);
      const qs = p.toString();
      const r = await fetch(`/api/qa-prompt-testing/dashboard${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as DashData;
      if (seq !== reqSeq.current) return; // a newer load started — drop this stale response
      setData(json);
      setError(null);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError(e instanceof Error ? e.message : "Failed to load QA dashboard");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [scope, promptId]);

  // ── CSV exports ───────────────────────────────────────────────────────────────
  const exportSummary = useCallback(() => {
    if (!data) return;
    const header = ["Campaign", "Timezone", "Scope", "Last analyzed", "Analyzed", ...CA_COLS, ...RC_COLS];
    const rows: (string | number)[][] = data.campaigns.map((c) => [
      c.campaignName ?? c.campaignId,
      c.timezone,
      scope.day ?? scopeLabel,
      fmtDateTime(c.lastAnalyzedAt),
      c.total,
      ...CA_COLS.map((k) => c.callAttempt[k] ?? 0),
      ...RC_COLS.map((k) => c.reachedCategory[k] ?? 0),
    ]);
    downloadCsv(`qa-daily-summary-${scope.day ?? period}.csv`, [header, ...rows]);
  }, [data, scope, scopeLabel, period]);

  const exportRaw = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const p = new URLSearchParams({ limit: "5000", latestPerCall: "1" });
      if (scope.day) p.set("day", scope.day);
      else {
        if (scope.fromMs != null) p.set("fromMs", String(scope.fromMs));
        if (scope.toMs != null) p.set("toMs", String(scope.toMs));
      }
      if (promptId !== "all") p.set("promptId", promptId);
      const r = await fetch(`/api/qa-prompt-testing/runs?${p.toString()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const runs = ((await r.json()) as { runs: RawRun[] }).runs ?? [];
      const header = ["Local day", "Call time (UTC)", "Campaign", "Timezone", "Customer", "Phone", "Call attempt", "Reached category", "Goal reached", "Duration (s)", "Summary"];
      const rows: (string | number)[][] = runs.map((rn) => {
        const cat = parseCats(rn.summary);
        return [
          localDay(rn.callCreatedAt, rn.campaignTimezone),
          rn.callCreatedAt ?? "",
          rn.campaignName ?? "",
          rn.campaignTimezone ?? "",
          rn.customerName ?? "",
          rn.customerPhone ?? "",
          cat.callAttempt,
          cat.reachedCategory,
          rn.goalReached == null ? "" : rn.goalReached ? "yes" : "no",
          rn.durationSeconds ?? "",
          oneLineSummary(rn.summary),
        ];
      });
      downloadCsv(`qa-raw-${scope.day ?? period}.csv`, [header, ...rows]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Raw export failed");
    } finally {
      setExporting(false);
    }
  }, [scope, period, promptId]);

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
  // Early Hang-up is its own top-level call_attempt now (surfaced as a KPI + its own card).
  const earlyHangup = useMemo(() => (data ? n(data.byCallAttempt, "Early Hang-up") : 0), [data]);
  const earlyHangupPct = data && data.total ? Math.round((earlyHangup / data.total) * 100) : 0;

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
            <span className="text-[var(--text-2)]"> Showing {scopeLabel} · {promptId === "all" ? "all prompts (latest per call)" : (prompts.find((p) => p.id === promptId)?.title ?? "one prompt")}.</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={promptId}
            onChange={(e) => { setPromptId(e.target.value); setPage(1); }}
            title="Filter results by the prompt they were scored with (for prompt-vs-prompt comparison)"
            className="text-xs rounded-lg px-2 py-1.5 border bg-[var(--bg-card)] border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:border-primary/50 max-w-[200px]"
          >
            <option value="all">All prompts (latest per call)</option>
            {prompts.map((p) => (
              <option key={p.id} value={p.id}>{p.title}{p.isActive ? " (default)" : ""}</option>
            ))}
          </select>
          <div className="inline-flex gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
            {PERIODS.map((p) => (
              <button key={p.key} onClick={() => { setPeriod(p.key); setPage(1); }} className={dayCls(period === p.key)}>{p.label}</button>
            ))}
          </div>
          <input
            type="date"
            value={scope.day ?? ""}
            max={localDateStr(0)}
            onChange={(e) => { if (e.target.value) { setCustomDate(e.target.value); setPeriod("date"); setPage(1); } }}
            title="Show a specific day (each campaign's local day)"
            className={`text-xs rounded-lg px-2 py-1 border transition ${
              period === "date" ? "bg-primary/15 border-primary/40 text-[var(--text-1)]" : "bg-[var(--bg-card)] border-[var(--border)] text-[var(--text-2)]"
            }`}
          />
          <div className="inline-flex gap-1">
            <button
              onClick={exportSummary}
              disabled={!data || data.total === 0}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] disabled:opacity-40 transition"
              title="Export the per-campaign summary for this scope"
            >
              <Download size={13} /> Summary
            </button>
            <button
              onClick={exportRaw}
              disabled={exporting || !data || data.total === 0}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] disabled:opacity-40 transition"
              title="Export one row per analyzed call for this scope"
            >
              <Download size={13} /> {exporting ? "Exporting…" : "Raw calls"}
            </button>
          </div>
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
          <div className="grid gap-px bg-[var(--border)] border border-[var(--border)] rounded-[14px] overflow-hidden" style={{ gridTemplateColumns: "repeat(6,minmax(0,1fr))" }}>
            <KpiCard label="Analyzed" value={data.total} onClick={() => open({ title: "All analyzed calls" })} />
            <KpiCard label="Reached" value={n(data.byCallAttempt, "Reached")} accent="#3ec08a" onClick={() => open({ title: "Reached", callAttempt: "Reached" })} />
            <KpiCard label="Voicemail" value={n(data.byCallAttempt, "Voicemail")} accent="#8f86e6" onClick={() => open({ title: "Voicemail", callAttempt: "Voicemail" })} />
            <KpiCard label="Early Hang-up" value={n(data.byCallAttempt, "Early Hang-up")} accent="#e0814a" onClick={() => open({ title: "Early Hang-up", callAttempt: "Early Hang-up" })} />
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

          {/* Early Hang-up — its own top-level category now; clickable → the list, like a reached row. */}
          <WidgetCard title="Early Hang-up — outcome breakdown" icon={<PhoneOff size={14} className="text-[#e0814a]" />} context={`${earlyHangup.toLocaleString()} of ${data.total.toLocaleString()} analyzed`}>
            {earlyHangup === 0 ? (
              <p className="text-xs text-[var(--text-3)]">No early hang-ups in this period.</p>
            ) : (
              <button
                onClick={() => open({ title: "Early Hang-up", callAttempt: "Early Hang-up" })}
                className="flex w-full items-center gap-3 text-left hover:bg-[var(--bg-hover)] rounded-md px-1 py-0.5 transition"
              >
                <span className="w-28 shrink-0 text-xs text-[var(--text-2)]">Early Hang-up</span>
                <div className="flex-1 h-2.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${earlyHangupPct}%`, background: "#e0814a" }} />
                </div>
                <span className="w-24 shrink-0 text-right text-xs font-mono text-[var(--text-1)]">
                  {earlyHangup.toLocaleString()} <span className="text-[var(--text-3)]">· {earlyHangupPct}%</span>
                </span>
              </button>
            )}
          </WidgetCard>

          {/* Per-campaign table — clickable cells. Call-attempt totals (incl. Early Hang-up)
              + the reached-outcome breakdown (Positive … Agent Timeout), each cell drills down. */}
          <WidgetCard title="By campaign" icon={<ClipboardList size={14} className="text-blue-400" />} context={`${data.campaigns.length} campaign${data.campaigns.length === 1 ? "" : "s"}`} bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-[var(--text-3)]">
                    <th className="text-left font-semibold px-4 py-2 sticky left-0 bg-[var(--bg-card)]">Campaign</th>
                    <th className="text-right font-semibold px-3 py-2">Analyzed</th>
                    {CA_COLS.map((k) => (
                      <th key={k} className="text-right font-semibold px-3 py-2 whitespace-nowrap">{k}</th>
                    ))}
                    <th className="px-1 py-2 text-[var(--text-4)]">·</th>
                    {RC_COLS.map((k) => (
                      <th key={k} className="text-right font-semibold px-3 py-2 whitespace-nowrap" style={{ color: RC_COLOR[k] }}>{k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {pageCampaigns.map((c) => {
                    const name = c.campaignName ?? c.campaignId.slice(0, 8);
                    return (
                      <tr key={c.campaignId} className="hover:bg-[var(--bg-hover)] transition">
                        <td className="px-4 py-2 min-w-[240px] max-w-[440px] sticky left-0 bg-[var(--bg-card)] align-top">
                          <button
                            onClick={() => open({ title: name, campaignId: c.campaignId })}
                            className={`text-left text-[var(--text-1)] whitespace-normal break-words ${cellBtn}`}
                          >
                            {name}
                          </button>
                          {c.lastAnalyzedAt && (
                            <div className="text-[10px] text-[var(--text-3)] font-mono mt-0.5">Analyzed {fmtDateTime(c.lastAnalyzedAt)}</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[var(--text-1)]">{c.total.toLocaleString()}</td>
                        {CA_COLS.map((k) => {
                          const v = n(c.callAttempt, k);
                          return (
                            <td key={k} className="px-3 py-2 text-right font-mono">
                              <button
                                onClick={() => open({ title: `${name} · ${k}`, campaignId: c.campaignId, callAttempt: k })}
                                className={`${cellBtn} ${v > 0 ? CA_COL_CLS[k] : "text-[var(--text-3)]"}`}
                              >
                                {v.toLocaleString()}
                              </button>
                            </td>
                          );
                        })}
                        <td className="px-1 text-[var(--border-2)]">·</td>
                        {RC_COLS.map((k) => {
                          const v = n(c.reachedCategory, k);
                          return (
                            <td key={k} className="px-3 py-2 text-right font-mono">
                              <button
                                onClick={() => open({ title: `${name} · ${k}`, campaignId: c.campaignId, reachedCategory: k })}
                                className={cellBtn}
                                style={{ color: v > 0 ? RC_COLOR[k] : "var(--text-3)" }}
                              >
                                {v.toLocaleString()}
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </WidgetCard>

          <Pagination currentPage={safePage} totalPages={totalPages} totalItems={data.campaigns.length} pageSize={PAGE_SIZE} onPageChange={setPage} />

          <p className="text-[10px] text-[var(--text-3)]">
            {data.doubleChecked > 0
              ? <><span className="text-[var(--text-2)]">{data.doubleChecked.toLocaleString()}</span> of {data.total.toLocaleString()} verdicts were double-checked by gpt-5.4 (the Early-Hangup/Neutral cases).</>
              : "No calls have been double-checked by gpt-5.4 yet (re-analyze to apply the hybrid scorer)."}
            {data.unparseable > 0 && ` · ${data.unparseable} result${data.unparseable === 1 ? "" : "s"} couldn't be parsed as JSON (excluded).`}
          </p>
        </>
      )}

      {slice && <QaRecordsDrawer slice={slice} day={scope.day} fromMs={scope.fromMs} toMs={scope.toMs} promptId={promptId === "all" ? null : promptId} onClose={() => setSlice(null)} />}
    </div>
  );
}
