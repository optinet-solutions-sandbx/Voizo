"use client";

// AnalysisHistory — the QA Analysis History list (stored bulk-analysis runs).
// Newest first, searchable, paginated. Each row replays in /qa-prompt-testing/history/[id].

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronRight, Search } from "lucide-react";
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

const PAGE_SIZE = 15;

const fmt = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};

// Pull a short human line + optional resolution/verdict out of the stored summary
// (which is usually the model's JSON). Falls back to a raw snippet.
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const url = campaignId
        ? `/api/qa-prompt-testing/runs?campaignId=${encodeURIComponent(campaignId)}`
        : "/api/qa-prompt-testing/runs";
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRuns(((await r.json()) as { runs: RunItem[] }).runs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

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
  if (all.length === 0) {
    return (
      <div className="text-center py-16 text-sm text-[var(--text-3)]">
        No analysis runs yet. Run a <span className="text-[var(--text-2)]">Bulk analysis</span> on a campaign to populate this.
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <div className="relative w-64 max-w-full">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          placeholder="Search campaign, customer, prompt…"
          className="w-full text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-primary/50"
        />
      </div>

      {visible.length === 0 ? (
        <div className="text-sm text-[var(--text-3)] py-10 text-center">No runs match your search.</div>
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
  );
}
