// src/app/qa-prompt-testing/page.tsx
//
// QA Prompt Testing — landing. Two tabs:
//   • Campaigns    → pick a campaign, then a call, then test a prompt against it.
//   • Prompt Library → manage the reusable QA prompts.
// Campaign data comes from GET /api/qa-prompt-testing/campaigns (SQL rollup — fast),
// with name search / sort / region filter / pagination for consistency with Reviews.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ArrowDownWideNarrow, ChevronRight, ClipboardList, History, LayoutDashboard, Library, Search,
} from "lucide-react";
import { campaignRegion } from "@/lib/campaignRegion";
import { sortReviewCampaigns, regionsOf, filterByRegion, type ReviewSortKey } from "@/lib/reviewSort";
import Pagination from "@/components/Pagination";
import { SectionTick } from "../analytics/SectionIsland";
import PromptLibrary from "@/components/qa/PromptLibrary";
import AnalysisHistory from "@/components/qa/AnalysisHistory";
import QaDashboard from "@/components/qa/QaDashboard";

interface QaCampaign {
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  createdAt: string;
  conversationCount: number; // reached a live person (rollup `reach`)
  totalCallCount: number;
  goalReachedCount: number;
  labeledCount: number;
}

const PAGE_SIZE = 10;
const SORT_OPTIONS: { key: ReviewSortKey; label: string }[] = [
  { key: "conversations", label: "Most conversations" },
  { key: "newest", label: "Newest" },
  { key: "calls", label: "Most calls" },
  { key: "region", label: "Region" },
];

export default function QaPromptTestingPage() {
  const [tab, setTab] = useState<"campaigns" | "library" | "history" | "dashboard">("campaigns");
  const [campaigns, setCampaigns] = useState<QaCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // controls
  const [sort, setSort] = useState<ReviewSortKey>("conversations");
  const [region, setRegion] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/qa-prompt-testing/campaigns", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { campaigns } = (await r.json()) as { campaigns: QaCampaign[] };
      setCampaigns(campaigns);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "campaigns") load();
  }, [tab, load]);

  const all = useMemo(() => campaigns ?? [], [campaigns]);
  const regions = useMemo(() => regionsOf(all), [all]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q ? all.filter((c) => c.campaignName.toLowerCase().includes(q)) : all;
    return sortReviewCampaigns(filterByRegion(searched, region), sort);
  }, [all, region, sort, query]);

  // safePage clamps every render so a filter change that shrinks the list can't
  // strand the view on a now-empty page; the control handlers also reset to 1.
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visible, safePage],
  );

  const tabCls = (on: boolean) =>
    `inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap ${
      on ? "bg-[var(--bg-elevated)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
    }`;

  return (
    <div className="p-4 max-w-[1100px] mx-auto w-full grid gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <SectionTick color="#a78bfa" />
          <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">QA Prompt Testing</h1>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-[var(--text-3)]">
          Test a QA prompt against a real call. Pick a campaign, then a conversation, then run a prompt from your{" "}
          <strong className="text-[var(--text-2)]">Prompt Library</strong> against the call transcript — with audio,
          customer, and campaign context alongside.
        </p>
      </div>

      <div className="flex w-fit gap-1 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl">
        <button onClick={() => setTab("campaigns")} className={tabCls(tab === "campaigns")}>
          <ClipboardList size={13} /> Campaigns
        </button>
        <button onClick={() => setTab("library")} className={tabCls(tab === "library")}>
          <Library size={13} /> Prompt Library
        </button>
        <button onClick={() => setTab("history")} className={tabCls(tab === "history")}>
          <History size={13} /> Analysis History
        </button>
        <button onClick={() => setTab("dashboard")} className={tabCls(tab === "dashboard")}>
          <LayoutDashboard size={13} /> Dashboard
        </button>
      </div>

      {tab === "library" ? (
        <PromptLibrary />
      ) : tab === "history" ? (
        <AnalysisHistory />
      ) : tab === "dashboard" ? (
        <QaDashboard />
      ) : loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
          <AlertCircle size={11} /> {error}
        </p>
      ) : all.length === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">No campaigns with calls yet.</div>
      ) : (
        <>
          {/* search + sort + region controls */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                placeholder="Search campaigns…"
                className="w-56 max-w-full text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-primary/50"
              />
            </div>
            <SortControl sort={sort} onChange={(s) => { setSort(s); setPage(1); }} />
            {regions.length > 0 && (
              <RegionChips regions={regions} value={region} onChange={(r) => { setRegion(r); setPage(1); }} />
            )}
          </div>

          {visible.length === 0 ? (
            <div className="text-sm text-[var(--text-3)] py-10 text-center">No campaigns match these filters.</div>
          ) : (
            <>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
                {paginated.map((c) => (
                  <Link
                    key={c.campaignId}
                    href={`/qa-prompt-testing/${c.campaignId}`}
                    className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium text-[var(--text-1)] truncate">{c.campaignName}</span>
                        {campaignRegion(c.campaignName) && (
                          <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-primary/10 text-primary border-primary/25 flex-shrink-0">
                            {campaignRegion(c.campaignName)}
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-[var(--text-3)] font-mono mt-1">
                        {c.conversationCount} conversations · {c.totalCallCount} calls
                      </p>
                    </div>
                    <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition flex-shrink-0" />
                  </Link>
                ))}
              </div>
              <Pagination
                currentPage={safePage}
                totalPages={totalPages}
                totalItems={visible.length}
                pageSize={PAGE_SIZE}
                onPageChange={setPage}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function SortControl({ sort, onChange }: { sort: ReviewSortKey; onChange: (s: ReviewSortKey) => void }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <ArrowDownWideNarrow size={13} className="text-[var(--text-3)] flex-shrink-0" />
      <div className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
        {SORT_OPTIONS.map((o) => (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap ${
              sort === o.key ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function RegionChips({ regions, value, onChange }: { regions: string[]; value: string; onChange: (r: string) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1">
      {["all", ...regions].map((r) => (
        <button
          key={r}
          onClick={() => onChange(r)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium border transition whitespace-nowrap ${
            value === r
              ? "bg-[var(--bg-elevated)] text-[var(--text-1)] border-[var(--border-2)]"
              : "text-[var(--text-3)] border-[var(--border)] hover:text-[var(--text-1)]"
          }`}
        >
          {r === "all" ? "All regions" : r}
        </button>
      ))}
    </div>
  );
}
