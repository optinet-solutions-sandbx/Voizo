"use client";

import React, { useState, useMemo, useEffect, useRef, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import {
  Search, Plus, Loader2, Trash2, X, Megaphone, Repeat,
  Pause, Play, Copy, Clock, BarChart3, List, Download,
} from "lucide-react";
import { triggerDownload } from "@/lib/download";
import { buildAnalyticsCsv, buildAnalyticsJson } from "@/lib/analyticsExport";
import { PlusIcon } from "@/components/icons/animated/plus";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";
import { fetchCampaignsV2 } from "@/lib/campaignV2Data";
import { supabase } from "@/lib/supabase";
import Pagination from "@/components/Pagination";
import {
  computeCampaignAnalytics,
  computePortfolio,
  type CampaignAnalytics,
  type PortfolioRollup,
  type CampaignRow as AnalyticsCampaignRow,
  type NumberRow,
  type CallRow,
  type SmsRow,
} from "@/lib/campaignAnalytics";
import PortfolioKpiStrip from "@/components/analytics/PortfolioKpiStrip";
import AnalyticsTable from "@/components/analytics/AnalyticsTable";
import AnalyticsMobileCards from "@/components/analytics/AnalyticsMobileCards";

type CampaignRow = Record<string, unknown>;

type StatusFilter = "all" | "running" | "paused" | "completed" | "draft";
type TypeFilter = "all" | "fixed" | "recurring";
type DateFilter = "all" | "30d" | "7d";

const PAGE_SIZE = 10;

// ─────────────────────────────────────────────────────────────────────────
// Status + when helpers (unchanged business logic from prior implementation)
// ─────────────────────────────────────────────────────────────────────────

type WhenInfo = { label: string; sub?: string; muted?: boolean };

function formatWhen(c: CampaignRow): WhenInfo {
  const status = (c.status as string) || "draft";
  const startAt = c.start_at as string | null | undefined;
  const tz = c.timezone as string | undefined;
  const tzShort = tz ? tz.split("/").pop()?.replace(/_/g, " ") : undefined;

  if (status === "running") return { label: "Live now" };
  if (status === "scheduled" && startAt) return { label: relativeStart(startAt), sub: tzShort };
  if (status === "draft" && startAt) return { label: relativeStart(startAt), sub: tzShort ? `${tzShort} · draft` : "draft" };
  if (status === "draft") return { label: "Manual start", muted: true };
  if (status === "paused") return { label: "Paused", muted: true };
  return { label: "—", muted: true };
}

function relativeStart(iso: string): string {
  const ts = new Date(iso).getTime();
  const now = Date.now();
  const diff = ts - now;
  if (diff <= 0) return "Due now";

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "Starting now";
  if (minutes < 60) return `Starts in ${minutes}m`;
  if (hours < 24) return `Starts in ${hours}h`;

  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  if (days === 1) return `Tomorrow ${time}`;
  if (days < 7) {
    const dayName = date.toLocaleDateString("en-US", { weekday: "short" });
    return `${dayName} ${time}`;
  }
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ─────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────

function CampaignsPageInner() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [analytics, setAnalytics] = useState<Record<string, CampaignAnalytics>>({});
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [actionInFlightId, setActionInFlightId] = useState<string | null>(null);

  // URL-driven view toggle (Operational | Analytics). ?view=analytics is shareable + survives refresh.
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const view: "operational" | "analytics" = searchParams.get("view") === "analytics" ? "analytics" : "operational";
  function setView(next: "operational" | "analytics") {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next === "analytics") params.set("view", "analytics");
    else params.delete("view");
    const qs = params.toString();
    setCurrentPage(1); // reset pagination on mode switch (operational and analytics page over different sets)
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  // Initial fetch: campaigns + per-campaign aggregation from numbers + calls.
  useEffect(() => {
    (async () => {
      try {
        const rows = await fetchCampaignsV2();
        setCampaigns(rows);

        const ids = rows.map((r: CampaignRow) => r.id as string);
        if (ids.length === 0) { setLoading(false); return; }

        // PII-minimization (G6): select ONLY aggregation columns — never phone_e164,
        // transcript, body, to_phone_e164, error_message, or provider_message_id.
        const [numbersRes, callsRes, smsRes] = await Promise.all([
          supabase
            .from("campaign_numbers_v2")
            .select("id, campaign_id, outcome, created_at")
            .in("campaign_id", ids),
          supabase
            .from("calls_v2")
            .select("campaign_id, campaign_number_id, status, goal_reached, duration_seconds, created_at")
            .in("campaign_id", ids),
          supabase
            .from("sms_messages_v2")
            .select("campaign_id, status, provider")
            .in("campaign_id", ids),
        ]);
        // Loud over silent: a per-table read error degrades a metric to 0 — surface it, never hide it.
        if (numbersRes.error) console.error("[analytics] campaign_numbers_v2 read failed:", numbersRes.error);
        if (callsRes.error) console.error("[analytics] calls_v2 read failed:", callsRes.error);
        if (smsRes.error) console.error("[analytics] sms_messages_v2 read failed (SMS metrics read 0):", smsRes.error);

        const analyticsById = computeCampaignAnalytics({
          campaigns: rows as AnalyticsCampaignRow[],
          numbers: (numbersRes.data ?? []) as NumberRow[],
          calls: (callsRes.data ?? []) as CallRow[],
          sms: (smsRes.data ?? []) as SmsRow[],
          now: Date.now(),
        });
        setAnalytics(analyticsById);
      } catch (err) {
        console.error("Failed to fetch campaigns:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Status-only poll — visibility-aware, in-flight guarded, 30s.
  // Only runs when ≥1 campaign is in a non-terminal state.
  const hasActiveCampaign = useMemo(
    () => campaigns.some((c) => {
      const s = c.status as string;
      const startAt = c.start_at as string | null | undefined;
      if (s === "running" || s === "paused" || s === "scheduled") return true;
      if (s === "draft" && startAt) return true;
      return false;
    }),
    [campaigns],
  );

  const listPollInFlightRef = useRef(false);
  useEffect(() => {
    if (!hasActiveCampaign) return;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (listPollInFlightRef.current) return;
      listPollInFlightRef.current = true;
      try {
        const { data } = await supabase
          .from("campaigns_v2")
          .select("id, status, start_at")
          .order("created_at", { ascending: false });
        if (!data) return;
        const freshIds = new Set(data.map((d) => d.id));
        setCampaigns((prev) => {
          const surviving = prev.filter((c) => freshIds.has(c.id as string));
          return surviving.map((c) => {
            const fresh = data.find((d) => d.id === (c.id as string));
            return fresh ? { ...c, status: fresh.status, start_at: fresh.start_at } : c;
          });
        });
      } finally {
        listPollInFlightRef.current = false;
      }
    };
    const interval = setInterval(tick, 30000);
    return () => clearInterval(interval);
  }, [hasActiveCampaign]);

  // Aggregate totals for the stat strip (sourced from the analytics record).
  const totals = useMemo(() => {
    const vals = Object.values(analytics);
    const totalContacts = vals.reduce((s, v) => s + v.targeted, 0);
    const totalCalls = vals.reduce((s, v) => s + v.totalCalls, 0);
    const connectCount = vals.reduce((s, v) => s + v.connected, 0);
    const goalCount = vals.reduce((s, v) => s + v.goalCalls, 0);
    const connectRate = totalCalls > 0 ? ((connectCount / totalCalls) * 100).toFixed(1) : "0.0";
    // Operational Success is now goal-based Conversion (goal ÷ connected) — app-wide canon.
    const successRate = connectCount > 0 ? ((goalCount / connectCount) * 100).toFixed(1) : "0.0";
    return { totalContacts, totalCalls, connectCount, goalCount, connectRate, successRate };
  }, [analytics]);

  // Counts for filter pills
  const counts = useMemo(() => ({
    all: campaigns.length,
    running: campaigns.filter((c) => c.status === "running").length,
    paused: campaigns.filter((c) => c.status === "paused").length,
    completed: campaigns.filter((c) => c.status === "completed").length,
    draft: campaigns.filter((c) => c.status === "draft").length,
    fixed: campaigns.filter((c) => (c.campaign_type as string) !== "recurring").length,
    recurring: campaigns.filter((c) => (c.campaign_type as string) === "recurring").length,
  }), [campaigns]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return campaigns.filter((c) => {
      const status = (c.status as string) || "draft";
      const type = (c.campaign_type as string) === "recurring" ? "recurring" : "fixed";
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (typeFilter !== "all" && type !== typeFilter) return false;
      if (q && !(c.name as string).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [campaigns, searchQuery, statusFilter, typeFilter]);

  // Analytics records (per-campaign), date-filtered. The date chip filters WHICH campaigns
  // appear (by start_at); per-row metrics stay lifetime totals (spec §2). Portfolio rolls up
  // over the in-scope set.
  const analyticsRecords = useMemo(() => {
    const list = filtered.map((c) => analytics[c.id as string]).filter(Boolean) as CampaignAnalytics[];
    if (dateFilter === "all") return list;
    const days = dateFilter === "30d" ? 30 : 7;
    const cutoff = Date.now() - days * 86_400_000;
    return list.filter((a) => a.startAt != null && Date.parse(a.startAt) >= cutoff);
  }, [filtered, analytics, dateFilter]);
  const portfolio: PortfolioRollup = useMemo(() => computePortfolio(analyticsRecords), [analyticsRecords]);

  // View-aware paging: operational pages over `filtered`, analytics over `analyticsRecords`.
  const activeList = view === "analytics" ? analyticsRecords : filtered;
  const totalPages = Math.max(1, Math.ceil(activeList.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const analyticsPaginated = analyticsRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function handleSearch(q: string) { setSearchQuery(q); setCurrentPage(1); }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/campaigns-v2/${id}`, { method: "DELETE" });
      if (res.ok) setCampaigns((prev) => prev.filter((c) => (c.id as string) !== id));
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  async function handleStop(id: string) {
    setActionInFlightId(id);
    try {
      const res = await fetch(`/api/campaigns-v2/${id}/stop`, { method: "POST" });
      if (res.ok) {
        setCampaigns((prev) => prev.map((c) => (c.id as string) === id ? { ...c, status: "paused" } : c));
      }
    } catch (err) {
      console.error("Stop failed:", err);
    } finally {
      setActionInFlightId(null);
    }
  }

  async function handleResume(id: string) {
    setActionInFlightId(id);
    try {
      const res = await fetch(`/api/campaigns-v2/${id}/resume`, { method: "POST" });
      if (res.ok) {
        setCampaigns((prev) => prev.map((c) => (c.id as string) === id ? { ...c, status: "running" } : c));
      }
    } catch (err) {
      console.error("Resume failed:", err);
    } finally {
      setActionInFlightId(null);
    }
  }

  // 2026-05-21: Duplicate is now a pre-wizard diff gate. Route to the source's
  // detail page with ?action=duplicate so the (existing) modal there opens
  // automatically. Same modal everyone sees — no shortcut path. The
  // window.prompt + direct-create flow is deleted (per design pivot).
  function handleDuplicate(id: string) {
    router.push(`/campaigns/v2/${id}?action=duplicate`);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2">
        <Loader2 size={20} className="animate-spin text-blue-500" />
        <span className="text-sm text-[var(--text-3)]">Loading campaigns...</span>
      </div>
    );
  }

  const activeCount = campaigns.filter((c) => (c.status as string) !== "archived").length;
  const runningCount = campaigns.filter((c) => (c.status as string) === "running").length;

  return (
    <div className="p-4 sm:p-6 w-full max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between mb-6 gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-1)]">Campaigns</h1>
          <p className="text-xs text-[var(--text-3)] mt-1">
            {activeCount} campaign{activeCount !== 1 ? "s" : ""}
            {runningCount > 0 && (
              <span className="text-emerald-400 ml-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1 align-middle" />
                {runningCount} running
              </span>
            )}
          </p>
        </div>
        <Link
          href="/campaigns/v2/new"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-semibold shadow-md shadow-blue-500/20 transition hover:bg-blue-400 hover:-translate-y-px flex-shrink-0"
        >
          <HoverIcon icon={PlusIcon} size={14} />
          New Campaign
        </Link>
      </div>

      {/* View toggle */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl w-fit">
          <button
            onClick={() => setView("operational")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${view === "operational" ? "bg-[var(--bg-elevated)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
          >
            <List size={13} /> Operational
          </button>
          <button
            onClick={() => setView("analytics")}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition ${view === "analytics" ? "bg-[var(--bg-elevated)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
          >
            <BarChart3 size={13} /> Analytics
          </button>
        </div>
        {view === "analytics" && (
          <FilterGroup
            options={[
              { key: "all", label: "All time" },
              { key: "30d", label: "30d" },
              { key: "7d", label: "7d" },
            ]}
            value={dateFilter}
            onChange={(v) => { setDateFilter(v); setCurrentPage(1); }}
          />
        )}
        {view === "analytics" && (
          <div className="flex items-center gap-2 ml-auto">
            <button
              onClick={() => {
                const csv = buildAnalyticsCsv(analyticsRecords);
                triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), "voizo_analytics_all.csv");
              }}
              disabled={analyticsRecords.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] transition disabled:opacity-40"
            >
              <Download size={13} /> Export all (CSV)
            </button>
            <button
              onClick={() => {
                const json = buildAnalyticsJson(analyticsRecords, new Date().toISOString(), portfolio);
                triggerDownload(new Blob([json], { type: "application/json" }), "voizo_analytics_all.json");
              }}
              disabled={analyticsRecords.length === 0}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium bg-[var(--bg-card)] border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] transition disabled:opacity-40"
            >
              <Download size={13} /> Export all (JSON)
            </button>
          </div>
        )}
      </div>

      {/* Stats / Portfolio KPIs */}
      {view === "operational" ? (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-5">
          <StatCard label="Contacts"     value={totals.totalContacts.toLocaleString()} />
          <StatCard label="Calls"        value={totals.totalCalls.toLocaleString()}    accent="text-blue-400" />
          <StatCard label="Connect Rate" value={`${totals.connectRate}%`}              accent="text-emerald-400" hint="connected ÷ all calls — no min-duration floor; 2s answer-drops count (spec §6.5)" />
          <StatCard label="Success Rate" value={`${totals.successRate}%`}              accent="text-amber-400" />
        </section>
      ) : (
        <PortfolioKpiStrip portfolio={portfolio} />
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2.5 flex-wrap mb-4">
        <div className="flex-1 min-w-[240px] flex items-center gap-2 px-3.5 py-2.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl focus-within:border-blue-500 transition">
          <Search size={14} className="text-[var(--text-3)]" />
          <input
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Search campaigns…"
            className="flex-1 bg-transparent border-none outline-none text-sm placeholder-[var(--text-3)] text-[var(--text-1)]"
          />
          {searchQuery && (
            <button onClick={() => handleSearch("")} className="text-[var(--text-3)] hover:text-[var(--text-2)]">
              <X size={13} />
            </button>
          )}
        </div>
        <FilterGroup
          options={[
            { key: "all",       label: `All ${counts.all}` },
            { key: "running",   label: `Running ${counts.running}` },
            { key: "paused",    label: `Paused ${counts.paused}` },
            { key: "completed", label: `Completed ${counts.completed}` },
            { key: "draft",     label: `Draft ${counts.draft}` },
          ]}
          value={statusFilter}
          onChange={(v) => { setStatusFilter(v); setCurrentPage(1); }}
        />
        <FilterGroup
          options={[
            { key: "all",       label: `All ${counts.all}` },
            { key: "fixed",     label: `Fixed ${counts.fixed}` },
            { key: "recurring", label: `Recurring ${counts.recurring}` },
          ]}
          value={typeFilter}
          onChange={(v) => { setTypeFilter(v); setCurrentPage(1); }}
        />
      </div>

      {/* Table / cards */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        {campaigns.length === 0 ? (
          <div className="px-6 py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
              <Plus size={22} className="text-blue-400" />
            </div>
            <p className="text-sm font-medium text-[var(--text-1)] mb-1">No campaigns yet</p>
            <p className="text-xs text-[var(--text-3)] mb-4">Create your first AI-powered outbound campaign</p>
            <Link href="/campaigns/v2/new" className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
              <HoverIcon icon={PlusIcon} size={14} /> New Campaign
            </Link>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-[var(--text-3)]">
            No campaigns match the current filters.
          </div>
        ) : view === "operational" ? (
          <>
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-[var(--border)]">
              {paginated.map((c) => {
                const id = c.id as string;
                const a = analytics[id];
                const totalContacts = a?.targeted ?? 0;
                const totalCalls = a?.totalCalls ?? 0;
                const connectCount = a?.connected ?? 0;
                const connectRate = totalCalls > 0 ? ((connectCount / totalCalls) * 100).toFixed(1) + "%" : "0%";
                const hasActivity = totalCalls > 0;
                const when = formatWhen(c);
                const isRecurring = (c.campaign_type as string) === "recurring";
                return (
                  <div
                    key={id}
                    onClick={() => router.push(`/campaigns/v2/${id}`)}
                    className={`px-4 py-3.5 cursor-pointer transition-colors hover:bg-[var(--bg-hover)] ${!hasActivity ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="w-8 h-8 rounded-lg bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)] flex-shrink-0">
                          {isRecurring ? <Repeat size={13} /> : <Megaphone size={13} />}
                        </div>
                        <span className="font-semibold text-[var(--text-1)] text-sm truncate">{c.name as string}</span>
                      </div>
                      <StatusBadge status={(c.status as string) || "draft"} />
                    </div>
                    <div className="flex items-center gap-1.5 mb-2.5 ml-10">
                      <Clock size={10} className={when.muted ? "text-[var(--text-3)]/50 shrink-0" : "text-[var(--text-3)] shrink-0"} />
                      <p className={`text-[11px] truncate ${when.muted ? "text-[var(--text-3)]" : "text-[var(--text-2)]"}`}>
                        {when.label}
                        {when.sub && <span className="text-[var(--text-3)] ml-1">· {when.sub}</span>}
                      </p>
                    </div>
                    <div className="grid grid-cols-3 gap-3 ml-10">
                      <div>
                        <p className="text-[10px] text-[var(--text-3)] mb-0.5">Contacts</p>
                        <p className="text-xs font-semibold text-[var(--text-2)]">{totalContacts.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[var(--text-3)] mb-0.5">Calls</p>
                        <p className="text-xs font-semibold text-[var(--text-2)]">{totalCalls.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[var(--text-3)] mb-0.5">Connect</p>
                        <p className="text-xs font-semibold text-[var(--text-2)]">{connectRate}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr>
                    <Th>Campaign</Th>
                    <Th>When</Th>
                    <Th alignRight>Contacts</Th>
                    <Th alignRight>Calls</Th>
                    <Th alignRight>Connect</Th>
                    <Th alignRight>Success</Th>
                    <Th>Status</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((c) => {
                    const id = c.id as string;
                    const name = c.name as string;
                    const a = analytics[id];
                    const totalContacts = a?.targeted ?? 0;
                    const totalCalls = a?.totalCalls ?? 0;
                    const connectCount = a?.connected ?? 0;
                    const goalCount = a?.goalCalls ?? 0;
                    const connectRate = totalCalls > 0 ? ((connectCount / totalCalls) * 100).toFixed(1) : "0";
                    // Success = goal-based Conversion (a.conversion); null (0 connected) => "0".
                    const successRate = a?.conversion != null ? (a.conversion * 100).toFixed(1) : "0";
                    const hasActivity = totalCalls > 0;
                    const when = formatWhen(c);
                    const status = (c.status as string) || "draft";
                    const isRecurring = (c.campaign_type as string) === "recurring";
                    const isInFlight = actionInFlightId === id;
                    return (
                      <tr
                        key={id}
                        onClick={() => router.push(`/campaigns/v2/${id}`)}
                        className={`group border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)] transition-colors cursor-pointer ${!hasActivity ? "opacity-60 hover:opacity-90" : ""}`}
                      >
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)] transition group-hover:scale-110 group-hover:-rotate-3 group-hover:bg-blue-500/15 group-hover:text-blue-400 flex-shrink-0">
                              {isRecurring ? <Repeat size={15} /> : <Megaphone size={15} />}
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-[var(--text-1)] group-hover:text-blue-400 transition-colors truncate">{name}</p>
                              {(c.vapi_assistant_name as string) && (
                                <p className="text-[11px] text-[var(--text-3)] mt-0.5 truncate font-mono">{c.vapi_assistant_name as string}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-xs">
                          <span className="inline-flex items-center gap-1.5">
                            <StatusDot status={status} />
                            <span className={when.muted ? "text-[var(--text-3)]" : "text-[var(--text-2)]"}>
                              {when.label}
                            </span>
                          </span>
                          {when.sub && <p className="text-[10px] text-[var(--text-3)] ml-3 mt-0.5">{when.sub}</p>}
                        </td>
                        <td className="px-4 py-4 text-right text-[var(--text-2)] font-mono tabular-nums">{totalContacts.toLocaleString()}</td>
                        <td className="px-4 py-4 text-right font-mono tabular-nums">
                          <span className={hasActivity ? "text-blue-400 font-semibold" : "text-[var(--text-3)]"}>{totalCalls.toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-4 text-right font-mono tabular-nums">
                          <span className={Number(connectRate) > 0 ? "text-emerald-400" : "text-[var(--text-3)]"}>{connectRate}%</span>
                          <span className="text-[var(--text-3)] text-[11px] ml-1">({connectCount})</span>
                        </td>
                        <td className="px-4 py-4 text-right font-mono tabular-nums">
                          <span className={Number(successRate) > 0 ? "text-amber-400" : "text-[var(--text-3)]"}>{successRate}%</span>
                          <span className="text-[var(--text-3)] text-[11px] ml-1">({goalCount})</span>
                        </td>
                        <td className="px-4 py-4"><StatusBadge status={status} /></td>
                        <td className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition">
                            {status === "running" ? (
                              <IconAction title="Pause" onClick={() => handleStop(id)} disabled={isInFlight}><Pause size={13} /></IconAction>
                            ) : status === "paused" ? (
                              <IconAction title="Resume" onClick={() => handleResume(id)} disabled={isInFlight}><Play size={13} /></IconAction>
                            ) : null}
                            <IconAction title="Duplicate" onClick={() => handleDuplicate(id)} disabled={isInFlight}><Copy size={13} /></IconAction>
                            {confirmDeleteId === id ? (
                              <span className="inline-flex items-center gap-2 px-2">
                                <button
                                  onClick={() => handleDelete(id)}
                                  disabled={deleting}
                                  className="text-[11px] text-red-400 hover:text-red-300 font-semibold disabled:opacity-50"
                                >
                                  {deleting ? "..." : "Yes"}
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="text-[11px] text-[var(--text-3)] hover:text-[var(--text-2)]"
                                >
                                  No
                                </button>
                              </span>
                            ) : (
                              status !== "running" && (
                                <IconAction title="Delete" onClick={() => setConfirmDeleteId(id)} danger>
                                  <Trash2 size={13} />
                                </IconAction>
                              )
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : analyticsRecords.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-[var(--text-3)]">
            No campaigns in this date window.
          </div>
        ) : (
          <>
            <AnalyticsMobileCards records={analyticsPaginated} portfolio={portfolio} />
            <AnalyticsTable records={analyticsPaginated} portfolio={portfolio} />
          </>
        )}

        {activeList.length > 0 && (
          <div className="border-t border-[var(--border)] px-5 py-3">
            <Pagination
              currentPage={safePage}
              totalPages={totalPages}
              totalItems={activeList.length}
              pageSize={PAGE_SIZE}
              onPageChange={setCurrentPage}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export default function CampaignsPage() {
  // useSearchParams() requires a Suspense boundary in Next 16 (workers/page.tsx pattern).
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64 gap-2">
          <Loader2 size={20} className="animate-spin text-blue-500" />
          <span className="text-sm text-[var(--text-3)]">Loading campaigns...</span>
        </div>
      }
    >
      <CampaignsPageInner />
    </Suspense>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function StatCard({ label, value, accent, hint }: {
  label: string; value: string; accent?: string; hint?: string;
}) {
  // No sparkline: the previous hardcoded static polyline was identical on every card
  // and not data-driven — it "quietly lied" (spec §6.7 / G8). Removed in both modes.
  return (
    <div title={hint} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl px-5 py-4 transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/20">
      <div className="text-[11px] uppercase tracking-wider font-medium text-[var(--text-3)]">{label}</div>
      <div className={`text-[26px] font-bold tabular-nums leading-tight mt-1 ${accent ?? "text-[var(--text-1)]"}`}>{value}</div>
    </div>
  );
}

function FilterGroup<T extends string>({
  options, value, onChange,
}: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl flex-shrink-0">
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap ${
            value === o.key
              ? "bg-[var(--bg-elevated)] text-[var(--text-1)]"
              : "text-[var(--text-3)] hover:text-[var(--text-1)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = {
    running: "bg-emerald-500",
    paused: "bg-amber-500",
    completed: "bg-blue-500",
    scheduled: "bg-cyan-500",
  }[status] ?? "bg-[var(--text-3)]";
  return <span className={`w-1.5 h-1.5 rounded-full ${color} ${status === "running" ? "animate-pulse" : ""}`} />;
}

function StatusBadge({ status }: { status: string }) {
  const cls = {
    draft:     "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]",
    scheduled: "bg-cyan-500/12 text-cyan-400 border-cyan-500/30",
    running:   "bg-emerald-500/12 text-emerald-400 border-emerald-500/30",
    paused:    "bg-amber-500/12 text-amber-400 border-amber-500/30",
    completed: "bg-blue-500/12 text-blue-400 border-blue-500/30",
    archived:  "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
    inactive:  "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
    skipped:   "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
  }[status] ?? "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold font-mono border ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full bg-current ${status === "running" ? "animate-pulse" : ""}`} />
      {status}
    </span>
  );
}

function Th({ children, alignRight }: { children?: React.ReactNode; alignRight?: boolean }) {
  return (
    <th className={`px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] border-b border-[var(--border)] ${alignRight ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function IconAction({ children, title, onClick, disabled, danger }: {
  children: React.ReactNode; title: string;
  onClick?: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`w-7 h-7 rounded-md grid place-items-center transition disabled:opacity-50 disabled:cursor-not-allowed hover:scale-110 ${
        danger
          ? "text-[var(--text-3)] hover:bg-red-500/10 hover:text-red-400"
          : "text-[var(--text-3)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)]"
      }`}
    >
      {children}
    </button>
  );
}
