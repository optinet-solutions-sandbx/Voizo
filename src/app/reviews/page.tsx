// src/app/reviews/page.tsx
//
// Reviews landing — a per-campaign coverage list. Each row: real-conversation
// count, how many the system marked goal-reached, and your labeling progress.
// Click a campaign to label its calls (good / bad / unsure + audio).
// Data: GET /api/reviews/campaigns. Server-side service role only.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDownWideNarrow, ChevronRight, ClipboardList, FlaskConical, Gauge } from "lucide-react";
import { sortReviewCampaigns, regionsOf, filterByRegion, type ReviewSortKey } from "@/lib/reviewSort";
import { campaignRegion } from "@/lib/campaignRegion";
import GoldenSetPanel from "./GoldenSetPanel";
import NorthStarPanel from "./NorthStarPanel";
import AgentPerformancePanel from "./AgentPerformancePanel";
import Pagination from "@/components/Pagination";
import Hint from "@/components/Hint";
import WidgetCard from "../analytics/WidgetCard";
import StatBand from "../analytics/StatBand";
import { SectionTick } from "../analytics/SectionIsland";

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
  { key: "leastLabeled", label: "Least labeled" },
  { key: "region", label: "Region" },
];
interface CampaignsResponse { campaigns: ReviewCampaign[]; reviewer: string }

export default function ReviewsPage() {
  const [data, setData] = useState<CampaignsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<"real" | "test">("real");
  const [sort, setSort] = useState<ReviewSortKey>("conversations");
  const [region, setRegion] = useState<string>("all");
  const [tab, setTab] = useState<"label" | "analytics">("label");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch ALL campaigns (real + test); we split them client-side by the isTest flag.
      const r = await fetch(`/api/reviews/campaigns?testOnly=false`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as CampaignsResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Split real vs test client-side — the API returns both, each with an isTest flag.
  const allCampaigns = useMemo(() => data?.campaigns ?? [], [data]);
  const realCount = useMemo(() => allCampaigns.filter((c) => !c.isTest).length, [allCampaigns]);
  const testCount = useMemo(() => allCampaigns.filter((c) => c.isTest).length, [allCampaigns]);
  const byKind = useMemo(
    () => allCampaigns.filter((c) => (kind === "test" ? c.isTest : !c.isTest)),
    [allCampaigns, kind],
  );

  const totals = useMemo(
    () => ({
      campaigns: byKind.length,
      conversations: byKind.reduce((s, c) => s + c.conversationCount, 0),
      goalReached: byKind.reduce((s, c) => s + c.goalReachedCount, 0),
      labeled: byKind.reduce((s, c) => s + c.labeledCount, 0),
    }),
    [byKind],
  );

  // Region chips (derived from the current kind) + the filtered+sorted view.
  const regions = useMemo(() => regionsOf(byKind), [byKind]);
  const visible = useMemo(
    () => sortReviewCampaigns(filterByRegion(byKind, region), sort),
    [byKind, region, sort],
  );

  // Numbered pagination (mirrors campaigns/page.tsx convention). safePage clamps every
  // render, so a filter change that shrinks the list can't strand the view on a now-empty
  // page; the filter handlers also reset page to 1 (no chained setState-in-effect).
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visible, safePage],
  );

  const tabClass = (t: "label" | "analytics") =>
    `px-4 py-2 text-sm font-medium rounded-xl transition-colors ${
      tab === t ? "bg-blue-600 text-white" : "text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
    }`;
  const kindBtn = (k: "real" | "test") =>
    `px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap ${
      kind === k ? "bg-blue-500 text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
    }`;

  return (
    // Shell — SectionTick + 18px header, matching the dashboard section-header pattern
    // (design-system rollout, Jasiel 2026-07-08). p-4/gap-4 console density; max-w reading
    // column kept (Reviews is a content column, not a full-bleed data table like DNC/Knowledge).
    <div className="p-4 max-w-[1100px] mx-auto w-full grid gap-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2.5">
            <SectionTick color="#60a5fa" />
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">Reviews</h1>
          </div>
          <p className="text-xs text-[var(--text-3)] mt-0.5">
            Pick a campaign to label its real conversations good / bad — your verdict is the ground truth the AI judge calibrates against.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
          {tab === "label" && (
            <div className="inline-flex gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]" title="Real and test campaigns are listed separately">
              <button type="button" onClick={() => { setKind("real"); setRegion("all"); setPage(1); }} className={kindBtn("real")}>
                Real{realCount > 0 ? ` (${realCount})` : ""}
              </button>
              <button type="button" onClick={() => { setKind("test"); setRegion("all"); setPage(1); }} className={kindBtn("test")}>
                <FlaskConical size={11} className="inline -mt-0.5 mr-1" />Test{testCount > 0 ? ` (${testCount})` : ""}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* tabs — Label calls (the labeling workflow) vs Analytics (the eval panels) */}
      <div className="flex gap-1">
        <button type="button" className={tabClass("label")} onClick={() => setTab("label")}>
          <ClipboardList size={14} className="inline mr-1.5 -mt-0.5" />Label calls
        </button>
        <button type="button" className={tabClass("analytics")} onClick={() => setTab("analytics")}>
          <Gauge size={14} className="inline mr-1.5 -mt-0.5" />Analytics
        </button>
      </div>

      {tab === "label" && (
        <>
          {/* totals strip — shared StatBand KPI strip (design-system rollout). Loading shows
              "—" (string, no CountUp); loaded numbers CountUp. Goal reached uses the DS
              semantic green (#3ec08a, same as the dashboard's Positive response). */}
          <div className="grid gap-2">
            <StatBand stats={[
              { label: "Campaigns", value: loading ? "—" : totals.campaigns },
              { label: "Conversations", value: loading ? "—" : totals.conversations },
              { label: "Goal reached", value: loading ? "—" : totals.goalReached, accent: "#3ec08a" },
              { label: "Labeled by you", value: loading ? "—" : totals.labeled, accent: "#60a5fa" },
            ]} />
            <p className="text-[11px] text-[var(--text-3)]">
              Voicemails, no-answers, and AI-only calls are filtered out — only genuine customer conversations appear.
            </p>
          </div>

          {loading ? (
            <SkeletonRows count={6} />
          ) : byKind.length === 0 ? (
            <EmptyState testOnly={kind === "test"} />
          ) : (
            <>
              {/* sort + region controls */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <SortControl sort={sort} onChange={(s) => { setSort(s); setPage(1); }} />
                {regions.length > 0 && <RegionChips regions={regions} value={region} onChange={(r) => { setRegion(r); setPage(1); }} />}
              </div>

              {visible.length === 0 ? (
                <div className="text-sm text-[var(--text-3)] py-10 text-center">No campaigns in this region.</div>
              ) : (
                <>
                  <WidgetCard
                    title="Campaigns"
                    icon={<ClipboardList size={14} className="text-blue-400" />}
                    context={region === "all"
                      ? `${visible.length} campaign${visible.length !== 1 ? "s" : ""}`
                      : `${visible.length} in ${region}`}
                    bodyClassName="p-0"
                  >
                    <div className="divide-y divide-[var(--border)]">
                      {paginated.map((c) => <CampaignRow key={c.campaignId} c={c} />)}
                    </div>
                  </WidgetCard>
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
        </>
      )}

      {tab === "analytics" && (
        <>
          <AgentPerformancePanel />
          <NorthStarPanel />
          <GoldenSetPanel />
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
              sort === o.key ? "bg-blue-500 text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
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

function CampaignRow({ c }: { c: ReviewCampaign }) {
  const pctGoal = c.conversationCount > 0 ? Math.round((c.goalReachedCount / c.conversationCount) * 100) : 0;
  const pctLabeled = c.conversationCount > 0 ? Math.round((c.labeledCount / c.conversationCount) * 100) : 0;
  const done = c.labeledCount >= c.conversationCount && c.conversationCount > 0;

  return (
    <Link href={`/reviews/${c.campaignId}`} className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-[var(--text-1)] truncate">{c.campaignName}</span>
          {campaignRegion(c.campaignName) && (
            <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-blue-500/10 text-blue-300 border-blue-500/25 flex-shrink-0">{campaignRegion(c.campaignName)}</span>
          )}
          {c.isTest && (
            <Hint content="Test campaign — listed separately and excluded from real metrics.">
              <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-violet-500/15 text-violet-400 border-violet-500/30 flex-shrink-0 cursor-help">test</span>
            </Hint>
          )}
        </div>
        {/* labeling progress bar */}
        <div className="flex items-center gap-2 mt-1.5">
          <div className="h-1.5 w-32 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
            <div className={`h-full ${done ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${pctLabeled}%` }} />
          </div>
          <span className="text-[10px] text-[var(--text-3)] font-mono">{c.labeledCount}/{c.conversationCount} labeled</span>
        </div>
      </div>

      <div className="hidden sm:flex items-center gap-5 flex-shrink-0 text-right">
        <Metric value={c.totalCallCount} label="calls" tone="text-[var(--text-2)]" title="All calls placed (incl. voicemail / no-answer / AI-only)" />
        <Metric value={c.conversationCount} label="convos" />
        <Metric value={`${c.goalReachedCount}`} sub={`${pctGoal}%`} label="goal" tone="text-emerald-400" title="Calls the system marked goal_reached" />
      </div>

      <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition flex-shrink-0" />
    </Link>
  );
}

function Metric({ value, sub, label, tone, title }: { value: string | number; sub?: string; label: string; tone?: string; title?: string }) {
  // Honesty disclosure surfaced via the shared Hint (styled tooltip) instead of native
  // title= (design-system rollout) — falls back to a plain cell when there's nothing to explain.
  const body = (
    <div className={`min-w-[52px] ${title ? "cursor-help" : ""}`}>
      <div className="flex items-baseline justify-end gap-1">
        <span className={`text-sm font-bold tabular-nums ${tone ?? "text-[var(--text-1)]"}`}>{value}</span>
        {sub && <span className="text-[10px] text-[var(--text-3)] font-mono">{sub}</span>}
      </div>
      <div className="text-[10px] text-[var(--text-3)] uppercase tracking-wider">{label}</div>
    </div>
  );
  return title ? <Hint content={title}>{body}</Hint> : body;
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-1.5 w-32 rounded bg-[var(--bg-elevated)] animate-pulse" />
          </div>
          <div className="h-6 w-24 rounded bg-[var(--bg-elevated)] animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ testOnly }: { testOnly: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)]">
        <ClipboardList size={20} />
      </div>
      <p className="text-sm text-[var(--text-2)]">No campaigns with real conversations{testOnly ? " in the test set" : ""} yet.</p>
      <p className="text-xs text-[var(--text-3)]">Conversations appear once calls complete with a customer on the line.</p>
    </div>
  );
}
