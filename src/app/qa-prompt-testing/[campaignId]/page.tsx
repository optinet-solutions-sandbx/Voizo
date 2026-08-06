// src/app/qa-prompt-testing/[campaignId]/page.tsx
//
// QA Prompt Testing — the conversations in one campaign. Pick a conversation to
// open the tester. Reuses GET /api/reviews/queue?campaignId=… (real conversations
// only, each with a transcript + audio), with search / sort / goal filter /
// pagination for consistency with the landing.

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowDownWideNarrow, ArrowLeft, ChevronRight, Layers, Search, Target, Volume2, VolumeX } from "lucide-react";
import Pagination from "@/components/Pagination";

interface QueueItem {
  callId: string;
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  createdAt: string;
  durationSeconds: number | null;
  status: string;
  goalReached: boolean | null;
  transcript: string;
  audioUrl: string | null;
}

type SortKey = "longest" | "newest" | "shortest";
type GoalFilter = "all" | "true" | "false";
const PAGE_SIZE = 10;
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "longest", label: "Longest" },
  { key: "newest", label: "Newest" },
  { key: "shortest", label: "Shortest" },
];

const fmtDate = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};
const fmtDur = (s: number | null) => (s == null ? "—" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
const snippet = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 120);

export default function CampaignCallsPage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = String(params?.campaignId ?? "");
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // controls
  const [sort, setSort] = useState<SortKey>("longest");
  const [goalFilter, setGoalFilter] = useState<GoalFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reviews/queue?campaignId=${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items } = (await r.json()) as { items: QueueItem[] };
      setItems(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (campaignId) load();
  }, [campaignId, load]);

  const campaignName = items?.[0]?.campaignName ?? "Campaign";
  const all = useMemo(() => items ?? [], [items]);

  // Search first so the goal-filter chip counts reflect the current search.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((i) => (i.transcript || "").toLowerCase().includes(q)) : all;
  }, [all, query]);

  const counts = useMemo(
    () => ({
      all: searched.length,
      true: searched.filter((i) => i.goalReached === true).length,
      false: searched.filter((i) => i.goalReached !== true).length,
    }),
    [searched],
  );

  const visible = useMemo(() => {
    const filtered =
      goalFilter === "all"
        ? searched
        : searched.filter((i) => (goalFilter === "true" ? i.goalReached === true : i.goalReached !== true));
    const arr = [...filtered];
    arr.sort((a, b) => {
      if (sort === "newest") return (b.createdAt || "").localeCompare(a.createdAt || "");
      const da = a.durationSeconds ?? 0;
      const db = b.durationSeconds ?? 0;
      return sort === "shortest" ? da - db : db - da;
    });
    return arr;
  }, [searched, goalFilter, sort]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = useMemo(
    () => visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [visible, safePage],
  );

  return (
    <div className="p-4 max-w-[1100px] mx-auto w-full grid gap-4">
      <div>
        <Link
          href="/qa-prompt-testing"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition mb-2"
        >
          <ArrowLeft size={13} /> All campaigns
        </Link>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)] truncate max-w-[760px]">
              {loading ? "Loading…" : campaignName}
            </h1>
            <p className="text-xs text-[var(--text-3)] mt-0.5">
              {items ? `${items.length} conversation${items.length === 1 ? "" : "s"} · pick one to test a prompt` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {error && (
              <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
                <AlertCircle size={11} /> {error}
              </span>
            )}
            <Link
              href={`/qa-prompt-testing/${campaignId}/batch`}
              className="inline-flex items-center gap-1.5 bg-primary hover:opacity-90 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition whitespace-nowrap"
            >
              <Layers size={13} /> Bulk analysis
            </Link>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />
          ))}
        </div>
      ) : all.length === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">
          No real conversations in this campaign. Voicemails, no-answers, and AI-only calls are filtered out.
        </div>
      ) : (
        <>
          {/* search + sort + goal filter */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <input
                value={query}
                onChange={(e) => { setQuery(e.target.value); setPage(1); }}
                placeholder="Search transcript…"
                className="w-60 max-w-full text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-lg pl-8 pr-3 py-1.5 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-primary/50"
              />
            </div>
            <div className="inline-flex items-center gap-1.5">
              <ArrowDownWideNarrow size={13} className="text-[var(--text-3)] flex-shrink-0" />
              <div className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--bg-card)] border border-[var(--border)]">
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.key}
                    onClick={() => { setSort(o.key); setPage(1); }}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition whitespace-nowrap ${
                      sort === o.key ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="inline-flex flex-wrap gap-1">
              <GoalChip active={goalFilter === "all"} onClick={() => { setGoalFilter("all"); setPage(1); }}>All · {counts.all}</GoalChip>
              <GoalChip active={goalFilter === "true"} tone="good" onClick={() => { setGoalFilter("true"); setPage(1); }}>Goal · {counts.true}</GoalChip>
              <GoalChip active={goalFilter === "false"} onClick={() => { setGoalFilter("false"); setPage(1); }}>No goal · {counts.false}</GoalChip>
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="text-sm text-[var(--text-3)] py-10 text-center">No conversations match these filters.</div>
          ) : (
            <>
              <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
                {paginated.map((it) => (
                  <Link
                    key={it.callId}
                    href={`/qa-prompt-testing/${campaignId}/${it.callId}`}
                    className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--text-3)]">
                        <span className="text-[var(--text-2)]">{fmtDate(it.createdAt)}</span>
                        <span>·</span>
                        <span>{fmtDur(it.durationSeconds)}</span>
                        <span>·</span>
                        <span>{it.status.replace(/_/g, " ")}</span>
                        {it.audioUrl ? <Volume2 size={11} className="text-[var(--text-3)]" /> : <VolumeX size={11} className="text-[var(--text-3)]" />}
                      </div>
                      <p className="text-xs text-[var(--text-2)] mt-1 truncate">{snippet(it.transcript) || "—"}</p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                        it.goalReached
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]"
                      }`}
                      title="The system's success flag (goal_reached)"
                    >
                      <Target size={9} /> {it.goalReached ? "goal" : "no goal"}
                    </span>
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
                noun="conversations"
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

function GoalChip({
  active, tone, onClick, children,
}: { active: boolean; tone?: "good"; onClick: () => void; children: React.ReactNode }) {
  const activeCls =
    tone === "good"
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"
      : "bg-primary/20 text-primary border-primary/50";
  return (
    <button
      onClick={onClick}
      className={`text-xs font-medium px-2.5 py-1 rounded-full border transition whitespace-nowrap ${
        active ? activeCls : "text-[var(--text-2)] border-[var(--border)] hover:border-[var(--border-2)] hover:text-[var(--text-1)]"
      }`}
    >
      {children}
    </button>
  );
}
