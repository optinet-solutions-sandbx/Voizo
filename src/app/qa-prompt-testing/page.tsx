// src/app/qa-prompt-testing/page.tsx
//
// QA Prompt Testing — landing. Two tabs:
//   • Campaigns    → pick a campaign, then a call, then test a prompt against it.
//   • Prompt Library → manage the reusable QA prompts.
// Campaign data reuses GET /api/reviews/campaigns (the same real-conversation
// aggregate the Reviews tool uses) with the same search / sort / filter / paginate
// controls for consistency.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ArrowDownWideNarrow, ChevronRight, FlaskConical, ClipboardList, Library, Search,
} from "lucide-react";
import { campaignRegion } from "@/lib/campaignRegion";
import { sortReviewCampaigns, regionsOf, filterByRegion, type ReviewSortKey } from "@/lib/reviewSort";
import Pagination from "@/components/Pagination";
import { SectionTick } from "../analytics/SectionIsland";
import PromptLibrary from "@/components/qa/PromptLibrary";

interface ReviewCampaign {
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  createdAt: string;
  conversationCount: number;
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
  const [tab, setTab] = useState<"campaigns" | "library">("campaigns");
  const [campaigns, setCampaigns] = useState<ReviewCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // controls
  const [kind, setKind] = useState<"real" | "test">("real");
  const [sort, setSort] = useState<ReviewSortKey>("conversations");
  const [region, setRegion] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/reviews/campaigns?testOnly=false", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { campaigns } = (await r.json()) as { campaigns: ReviewCampaign[] };
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
  const realCount = useMemo(() => all.filter((c) => !c.isTest).length, [all]);
  const testCount = useMemo(() => all.filter((c) => c.isTest).length, [all]);
  const byKind = useMemo(
    () => all.filter((c) => (kind === "test" ? c.isTest : !c.isTest)),
    [all, kind],
  );
  const regions = useMemo(() => regionsOf(byKind), [byKind]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const searched = q ? byKind.filter((c) => c.campaignName.toLowerCase().includes(q)) : byKind;
    return sortReviewCampaigns(filterByRegion(searched, region), sort);
  }, [byKind, region, sort, query]);

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
  const kindBtn = (k: "real" | "test") =>
    `px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap ${
      kind === k ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
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

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex w-fit gap-1 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl">
          <button onClick={() => setTab("campaigns")} className={tabCls(tab === "campaigns")}>
            <ClipboardList size={13} /> Campaigns
          </button>
          <button onClick={() => setTab("library")} className={tabCls(tab === "library")}>
            <Library size={13} /> Prompt Library
          </button>
        </div>
        {tab === "campaigns" && !loading && !error && (
          <div
            className="inline-flex gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]"
            title="Real and test campaigns are listed separately"
          >
            <button onClick={() => { setKind("real"); setRegion("all"); setPage(1); }} className={kindBtn("real")}>
              Real{realCount > 0 ? ` (${realCount})` : ""}
            </button>
            <button onClick={() => { setKind("test"); setRegion("all"); setPage(1); }} className={kindBtn("test")}>
              <FlaskConical size={11} className="inline -mt-0.5 mr-1" />Test{testCount > 0 ? ` (${testCount})` : ""}
            </button>
          </div>
        )}
      </div>

      {tab === "library" ? (
        <PromptLibrary />
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
      ) : byKind.length === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">
          No {kind === "test" ? "test " : ""}campaigns with real conversations yet.
        </div>
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
                        {c.isTest && (
                          <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-violet-500/15 text-violet-400 border-violet-500/30 flex-shrink-0 inline-flex items-center gap-1">
                            <FlaskConical size={9} /> test
                          </span>
                        )}
                      </div>
                      <p className="text-[10px] text-[var(--text-3)] font-mono mt-1">
                        {c.conversationCount} conversation{c.conversationCount === 1 ? "" : "s"} · {c.totalCallCount} calls
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
