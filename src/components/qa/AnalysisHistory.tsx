"use client";

// AnalysisHistory — the QA Analysis History view. Shows BATCHES first (all
// campaigns, running ones surfaced + live-polled for monitoring), then the stored
// analysis RESULTS (searchable, paginated). Each result replays in
// /qa-prompt-testing/history/[id]; each batch links to its campaign's batch page.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronRight, Layers, RefreshCw, Search } from "lucide-react";
import Pagination from "@/components/Pagination";

interface RunItem {
  id: string;
  callId: string;
  campaignId: string;
  campaignName: string | null;
  promptTitle: string | null;
  analyzedAt: string;
  summary: string | null;
  customerPhone: string | null;
  customerName: string | null;
  callCreatedAt: string | null;
  durationSeconds: number | null;
  goalReached: boolean | null;
}

interface BatchItem {
  id: string;
  campaignId: string;
  campaignName: string | null;
  status: string;
  promptTitle: string | null;
  totalConversations: number;
  completedConversations: number;
  failedConversations: number;
  importedCount: number;
  errorMessage: string | null;
  createdAt: string;
}

const PAGE_SIZE = 15;
const ACTIVE = new Set(["validating", "in_progress", "finalizing"]);
const POLL_MS = 6_000;

const fmt = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};
const statusLabel = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusCls = (s: string) => {
  if (s === "completed") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "failed" || s === "expired") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (s === "cancelled" || s === "cancelling") return "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]";
  return "bg-primary/15 text-primary border-primary/30";
};
const pctOf = (a: number, b: number) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);

// Pull a short human line + optional resolution/verdict out of the stored summary.
function digest(summary: string | null): { chip: string | null; text: string } {
  if (!summary) return { chip: null, text: "—" };
  const cleaned = summary.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  try {
    const o = JSON.parse(cleaned) as Record<string, unknown>;
    const chip =
      (typeof o.resolution_status === "string" && o.resolution_status) ||
      (typeof o.success_verdict === "string" && o.success_verdict) ||
      null;
    const text =
      (typeof o.summary === "string" && o.summary) ||
      (typeof o.rationale === "string" && o.rationale) ||
      cleaned.slice(0, 160);
    return { chip, text };
  } catch {
    return { chip: null, text: cleaned.replace(/\s+/g, " ").slice(0, 160) };
  }
}

export default function AnalysisHistory({ campaignId }: { campaignId?: string }) {
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchBatches = useCallback(async () => {
    try {
      const r = await fetch("/api/qa-prompt-testing/batches", { cache: "no-store" });
      if (r.ok) {
        let list = ((await r.json()) as { jobs: BatchItem[] }).jobs ?? [];
        if (campaignId) list = list.filter((b) => b.campaignId === campaignId);
        setBatches(list);
      }
    } catch {
      /* non-fatal — the results list still renders */
    }
  }, [campaignId]);

  const fetchRuns = useCallback(async () => {
    const url = campaignId
      ? `/api/qa-prompt-testing/runs?campaignId=${encodeURIComponent(campaignId)}`
      : "/api/qa-prompt-testing/runs";
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setRuns(((await r.json()) as { runs: RunItem[] }).runs);
  }, [campaignId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([fetchRuns(), fetchBatches()]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [fetchRuns, fetchBatches]);

  useEffect(() => {
    load();
  }, [load]);

  // Live-poll batches while any is active (monitoring).
  useEffect(() => {
    const active = batches.some((b) => ACTIVE.has(b.status));
    if (active && !pollRef.current) {
      fetchBatches();
      pollRef.current = setInterval(fetchBatches, POLL_MS);
    }
    if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [batches, fetchBatches]);

  const sortedBatches = useMemo(() => {
    const rank = (b: BatchItem) =>
      ACTIVE.has(b.status) ? 0 : b.status === "completed" && b.importedCount < b.totalConversations ? 1 : 2;
    return [...batches].sort((a, b) => rank(a) - rank(b) || (b.createdAt || "").localeCompare(a.createdAt || ""));
  }, [batches]);

  const all = useMemo(() => runs ?? [], [runs]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) =>
      [r.campaignName, r.customerName, r.customerPhone, r.promptTitle, r.summary]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q)),
    );
  }, [all, query]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(() => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [visible, safePage]);

  const hasActive = batches.some((b) => ACTIVE.has(b.status));

  if (loading) {
    return (
      <div className="grid gap-2">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-16 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />)}
      </div>
    );
  }
  if (error) {
    return (
      <p className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
        <AlertCircle size={11} /> {error}
      </p>
    );
  }
  if (all.length === 0 && batches.length === 0) {
    return (
      <div className="text-center py-16 text-sm text-[var(--text-3)]">
        No analysis yet. Run a <span className="text-[var(--text-2)]">Bulk analysis</span> on a campaign to populate this.
      </div>
    );
  }

  return (
    <div className="grid gap-5">
      {/* ── Batches (monitoring) ── */}
      {batches.length > 0 && (
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-[var(--text-1)] inline-flex items-center gap-1.5">
              <Layers size={14} className="text-primary" /> Batches
            </h2>
            <button onClick={fetchBatches} className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition">
              <RefreshCw size={12} /> Refresh{hasActive ? " · auto every 6s" : ""}
            </button>
          </div>
          {sortedBatches.map((b) => {
            const progress = pctOf(b.completedConversations, b.totalConversations);
            const pendingImport = b.status === "completed" && b.importedCount < b.totalConversations;
            return (
              <Link
                key={b.id}
                href={`/qa-prompt-testing/${b.campaignId}/batch`}
                className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 grid gap-2 hover:bg-[var(--bg-hover)] transition group"
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${statusCls(b.status)}`}>
                      {statusLabel(b.status)}
                    </span>
                    <span className="text-sm font-medium text-[var(--text-1)] truncate max-w-[240px]">{b.campaignName ?? "Campaign"}</span>
                    <span className="text-xs text-[var(--text-3)]">{b.totalConversations.toLocaleString()} calls</span>
                    {b.promptTitle && <span className="text-[11px] text-[var(--text-3)] truncate">· {b.promptTitle}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {pendingImport && <span className="text-[10px] font-medium text-emerald-400">Ready to import →</span>}
                    <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition" />
                  </div>
                </div>
                {(ACTIVE.has(b.status) || b.status === "completed") && (
                  <div>
                    <div className="flex justify-between text-[10px] text-[var(--text-3)] mb-1 font-mono">
                      <span>{b.completedConversations.toLocaleString()} / {b.totalConversations.toLocaleString()} processed{b.importedCount > 0 ? ` · ${b.importedCount.toLocaleString()} imported` : ""}</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${b.status === "completed" ? "bg-emerald-500" : "bg-primary"}`} style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}
                {b.errorMessage && (
                  <p className="text-[11px] text-red-400 inline-flex items-center gap-1"><AlertCircle size={11} /> {b.errorMessage}</p>
                )}
                <p className="text-[10px] text-[var(--text-3)] font-mono">{fmt(b.createdAt)}</p>
              </Link>
            );
          })}
        </div>
      )}

      {/* ── Results ── */}
      <div className="grid gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-semibold text-[var(--text-1)]">Results{all.length > 0 ? ` (${all.length})` : ""}</h2>
          <div className="relative w-64 max-w-full">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
              placeholder="Search campaign, customer, prompt…"
              className="w-full text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-primary/50"
            />
          </div>
        </div>

        {all.length === 0 ? (
          <div className="text-sm text-[var(--text-3)] py-8 text-center">No imported results yet — import a completed batch above.</div>
        ) : visible.length === 0 ? (
          <div className="text-sm text-[var(--text-3)] py-8 text-center">No results match your search.</div>
        ) : (
          <>
            <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
              {paginated.map((r) => {
                const d = digest(r.summary);
                return (
                  <Link
                    key={r.id}
                    href={`/qa-prompt-testing/history/${r.id}`}
                    className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0 flex-wrap">
                        <span className="text-sm font-medium text-[var(--text-1)] truncate max-w-[220px]">
                          {r.customerName || r.customerPhone || "Call"}
                        </span>
                        {r.campaignName && <span className="text-[11px] text-[var(--text-3)] truncate">· {r.campaignName}</span>}
                        {d.chip && (
                          <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-2)] border border-[var(--border)]">
                            {d.chip}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-[var(--text-2)] mt-1 truncate">{d.text}</p>
                      <p className="text-[10px] text-[var(--text-3)] font-mono mt-1">
                        {r.promptTitle ? `${r.promptTitle} · ` : ""}{fmt(r.analyzedAt)}
                      </p>
                    </div>
                    <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition flex-shrink-0" />
                  </Link>
                );
              })}
            </div>
            <Pagination
              currentPage={safePage}
              totalPages={totalPages}
              totalItems={visible.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              noun="runs"
            />
          </>
        )}
      </div>
    </div>
  );
}
