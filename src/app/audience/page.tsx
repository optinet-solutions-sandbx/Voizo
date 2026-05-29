// src/app/audience/page.tsx
//
// Audience CRM / Lead Recycling — list + detail panel (Slice 2 of 5).
//   - Left rail: saved local segments (snapshot counts, source campaign chip)
//   - Right panel: selected segment's phones + outcome badges
//   - Top: 4 stat cards aggregating across all segments
//
// Polling: 30s + manual Refresh button (mirrors /activity).
// Create + Launch-campaign buttons render disabled until Slice 3/4 land.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle, AlertTriangle, Clock, Filter, ListPlus, Loader2, Megaphone, Phone,
  Search, ShieldCheck, Trash2, Users,
} from "lucide-react";
import { RefreshCWIcon } from "@/components/icons/animated/refresh-cw";
import { HoverIcon } from "@/components/icons/animated/HoverIcon";

import CreateSegmentDrawer, { type CreateSegmentPrefill } from "./components/CreateSegmentDrawer";
import SuggestedSegmentsPanel, { type Suggestion } from "./components/SuggestedSegmentsPanel";
import { parseJsonBody } from "@/lib/jsonBody";

interface SegmentRow {
  id: string;
  name: string;
  source_campaign_id: string | null;
  source_campaign_name: string | null;
  outcomes_included: string[];
  dnc_scrubbed: boolean;
  recent_window_days: number;
  total_count: number;
  scrubbed_count: number;
  created_at: string;
  created_by: string | null;
}

interface SegmentNumber {
  id: string;
  phone_e164: string;
  source_outcome: string;
  source_attempts: number | null;
  created_at: string;
}

interface SegmentDetail {
  segment: SegmentRow;
  numbers: SegmentNumber[];
  pagination: { limit: number; nextCursor: string | null; hasMore: boolean };
}

const POLL_MS = 30_000;

export default function AudiencePage() {
  const [segments, setSegments] = useState<SegmentRow[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SegmentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<CreateSegmentPrefill | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<SegmentRow | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const router = useRouter();

  // Suggestions load (audience-suggestions MVP). Fetches the operator-facing
  // worklist from /api/audience/suggestions. Refreshes whenever segments
  // change so freshly-committed segments cause their source to disappear
  // from the panel (the RPC dedups on local_segments existence).
  const loadSuggestions = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch("/api/audience/suggestions", { cache: "no-store", signal });
      if (signal?.aborted) return;
      if (!r.ok) {
        console.warn(`[audience] suggestions fetch failed: HTTP ${r.status}`);
        setSuggestions([]);
        return;
      }
      const body = (await r.json()) as { suggestions: Suggestion[] };
      if (signal?.aborted) return;
      setSuggestions(body.suggestions ?? []);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.warn(`[audience] suggestions fetch error: ${(err as Error).message}`);
      setSuggestions([]);
    }
  }, []);

  // Carve handler — opens the drawer with the suggestion's defaults pre-filled.
  // Operator can still tweak name + outcomes + scrub settings before saving.
  // Drawer's onCreated callback will trigger a segments + suggestions refresh,
  // and the carved source will disappear from the panel (dedup'd by the RPC).
  const handleCarve = useCallback((s: Suggestion) => {
    setCreatePrefill({
      sourceCampaignId: s.source_campaign_id,
      name: s.suggested_defaults.name,
      outcomes: s.suggested_defaults.outcomes_included,
    });
    setCreateOpen(true);
  }, []);

  // 30s clock — enough precision for "5m ago" / "2h ago" labels. Cheaper
  // than the 1s clock /activity uses (no "Xs ago" labels here).
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // List load. Auto-selects the first segment iff nothing is selected yet —
  // this avoids a "select a segment to inspect" placeholder on first load
  // when at least one exists. Subsequent reloads preserve the selection.
  const loadSegments = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch("/api/audience/segments", { cache: "no-store", signal });
      if (signal?.aborted) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { segments: SegmentRow[] };
      if (signal?.aborted) return;
      const list = body.segments ?? [];
      setSegments(list);
      setSelectedId((prev) => prev ?? list[0]?.id ?? null);
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load segments");
    }
  }, []);

  // Initial + polling — both segments and suggestions are read-only fetches,
  // batched on the same 30s tick so the operator-facing state is always
  // consistent (no flicker of stale suggestions vs newly-committed segments).
  //
  // A2: Per-tick AbortController — each new tick aborts the previous tick's
  // in-flight requests so a slow response from a ghost tick can't clobber
  // fresh state. Cleanup on unmount aborts whatever's in flight.
  //
  // A7: visibilityState gate inside the interval body — skip polling work
  // when the operator is in another tab. The initial load on mount still
  // fires regardless (typical mount is in a visible tab).
  useEffect(() => {
    let currentCtrl: AbortController | null = null;
    const pollOnce = () => {
      if (currentCtrl) currentCtrl.abort();
      currentCtrl = new AbortController();
      const signal = currentCtrl.signal;
      loadSegments(signal);
      loadSuggestions(signal);
    };
    pollOnce();
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      pollOnce();
    }, POLL_MS);
    return () => {
      clearInterval(id);
      if (currentCtrl) currentCtrl.abort();
    };
  }, [loadSegments, loadSuggestions]);

  // Detail fetch on selection change — AbortController prevents an in-flight
  // detail load from clobbering a newer one when the operator clicks quickly.
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const ctrl = new AbortController();
    setDetailLoading(true);
    fetch(`/api/audience/segments/${selectedId}`, { cache: "no-store", signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as SegmentDetail;
      })
      .then((body) => setDetail(body))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("Failed to load segment detail:", err);
        setDetail(null);
      })
      .finally(() => setDetailLoading(false));
    return () => ctrl.abort();
  }, [selectedId]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadSegments();
    } finally {
      setIsRefreshing(false);
    }
  }, [loadSegments]);

  // Slice 5: Load more page of numbers for the currently-selected segment.
  // Appends to detail.numbers + advances pagination cursor.
  const loadMoreNumbers = useCallback(async () => {
    if (!detail || !selectedId || !detail.pagination.nextCursor) return;
    setLoadingMore(true);
    try {
      const qs = new URLSearchParams({ limit: "100", cursor: detail.pagination.nextCursor });
      const r = await fetch(`/api/audience/segments/${selectedId}?${qs}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as SegmentDetail;
      setDetail((prev) =>
        prev ? { ...prev, numbers: [...prev.numbers, ...body.numbers], pagination: body.pagination } : null,
      );
    } catch (err) {
      console.error("Failed to load more numbers:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [detail, selectedId]);

  // Slice 5: Delete a segment (after confirm). Cascades local_segment_numbers
  // via the FK on the server. Removes from local state + advances selection.
  const deleteSegment = useCallback(async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    try {
      const r = await fetch(`/api/audience/segments/${id}`, { method: "DELETE" });
      if (!r.ok) {
        const body = await parseJsonBody(r);
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      setSegments((prev) => {
        const remaining = prev?.filter((s) => s.id !== id) ?? null;
        if (selectedId === id) setSelectedId(remaining?.[0]?.id ?? null);
        return remaining;
      });
      setConfirmDelete(null);
      // Delete un-soft-marks the source's rows (DELETE endpoint restores
      // outcome='removed_from_segment' → 'pending'). That source may now
      // re-appear in suggestions if it crosses the candidate threshold.
      loadSuggestions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete segment");
      setConfirmDelete(null);
    }
  }, [confirmDelete, selectedId, loadSuggestions]);

  const stats = useMemo(() => {
    if (!segments) {
      return {
        totalSegments: 0, totalLeads: 0, totalScrubbed: 0,
        mostRecent: null as string | null,
      };
    }
    return {
      totalSegments: segments.length,
      totalLeads: segments.reduce((acc, s) => acc + s.total_count, 0),
      totalScrubbed: segments.reduce((acc, s) => acc + s.scrubbed_count, 0),
      mostRecent: segments[0]?.created_at ?? null,
    };
  }, [segments]);

  return (
    <div className="p-6 max-w-[1600px] mx-auto w-full grid gap-5">
      {/* Header */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight flex items-center gap-2.5">
            <Users size={22} className="text-amber-400" />
            Audience
          </h1>
          <p className="text-sm text-[var(--text-3)] mt-1">
            Carve outcome-tagged contacts into reusable segments · DNC-scrubbed by default
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-1)] bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg transition font-medium shadow-md shadow-blue-600/20"
          >
            <ListPlus size={12} /> Create segment
          </button>
          <button
            type="button"
            onClick={refresh}
            disabled={isRefreshing}
            title="Refresh now"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <HoverIcon icon={RefreshCWIcon} size={12} className={isRefreshing ? "animate-spin" : ""} />
            {isRefreshing ? "Refreshing…" : "Refresh"}
          </button>
          <span className="text-[10px] text-[var(--text-3)] font-mono">auto every 30s</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Saved segments" value={stats.totalSegments}
          icon={<Filter size={14} className="text-amber-400" />} />
        <StatCard label="Recycled leads" value={stats.totalLeads.toLocaleString()}
          icon={<Users size={14} className="text-blue-400" />} />
        <StatCard label="DNC + recent scrubbed" value={stats.totalScrubbed.toLocaleString()}
          icon={<ShieldCheck size={14} className="text-emerald-400" />} />
        <StatCard label="Most recent" value={stats.mostRecent ? formatRelative(stats.mostRecent, now) : "—"}
          icon={<Clock size={14} className="text-violet-400" />} />
      </div>

      {/* Suggested-segments panel (audience-suggestions MVP). Hidden when the
          worklist is empty — see SuggestedSegmentsPanel for the early-return.
          Suggestions are non-destructive; clicking "Carve segment" opens the
          drawer with prefill, no DB writes until the operator commits. */}
      <SuggestedSegmentsPanel suggestions={suggestions} onCarve={handleCarve} />

      {/* Main 2-col */}
      <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-5">
        {/* List */}
        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 max-h-[720px] overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">Segments</p>
            <span className="text-[10px] text-[var(--text-3)] font-mono">
              {segments ? `${segments.length}` : "…"}
            </span>
          </div>
          {!segments ? (
            <SkeletonRows count={4} />
          ) : segments.length === 0 ? (
            <EmptyState
              icon={<Users size={18} />}
              message="No recycled audiences yet."
              detail="Create one from any finished campaign's outcomes."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {segments.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className={`w-full text-left rounded-lg p-3 border transition ${
                      selectedId === s.id
                        ? "bg-blue-500/10 border-blue-500/40 text-[var(--text-1)]"
                        : "border-transparent hover:bg-[var(--bg-hover)] hover:border-[var(--border)] text-[var(--text-2)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold truncate">{s.name}</span>
                      <span className="font-mono text-xs tabular-nums text-[var(--text-1)] flex-shrink-0">
                        {s.total_count.toLocaleString()}
                      </span>
                    </div>
                    {s.source_campaign_name && (
                      <p className="text-[11px] text-[var(--text-3)] mt-0.5 truncate inline-flex items-center gap-1">
                        <Megaphone size={10} /> {s.source_campaign_name}
                      </p>
                    )}
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[10px] text-[var(--text-3)] font-mono">
                        {formatRelative(s.created_at, now)}
                      </span>
                      {s.scrubbed_count > 0 && (
                        <span className="text-[10px] text-emerald-400 font-mono inline-flex items-center gap-1">
                          <ShieldCheck size={9} /> {s.scrubbed_count} scrubbed
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Detail */}
        <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 sm:p-6 min-w-0">
          {!selectedId || !detail ? (
            <div className="h-full min-h-[480px] flex flex-col items-center justify-center gap-3 text-center">
              <div className="w-12 h-12 rounded-full bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)]">
                <Search size={20} />
              </div>
              <p className="text-sm text-[var(--text-2)]">
                {detailLoading ? "Loading segment…" : "Select a segment to inspect"}
              </p>
              <p className="text-xs text-[var(--text-3)] max-w-[320px]">
                Each segment is an immutable snapshot of contacts carved out of a finished campaign at a point in time.
              </p>
            </div>
          ) : (
            <SegmentDetailPanel
              detail={detail}
              loading={detailLoading}
              now={now}
              loadingMore={loadingMore}
              onLaunch={(id) => router.push(`/campaigns/v2/new?source=local_segment&id=${id}`)}
              onLoadMore={loadMoreNumbers}
              onDelete={(seg) => setConfirmDelete(seg)}
            />
          )}
        </section>
      </div>

      <CreateSegmentDrawer
        open={createOpen}
        prefill={createPrefill}
        onClose={() => {
          setCreateOpen(false);
          // Clear prefill so a subsequent manual "Create segment" click starts empty.
          setCreatePrefill(null);
        }}
        onCreated={(seg) => {
          // Prepend (server returns rows ordered by created_at desc).
          setSegments((prev) => (prev ? [seg, ...prev.filter((s) => s.id !== seg.id)] : [seg]));
          setSelectedId(seg.id);
          setCreateOpen(false);
          setCreatePrefill(null);
          // Refresh suggestions — the newly-committed source disappears from the panel.
          loadSuggestions();
        }}
      />

      {/* Slice 5: Delete confirmation modal */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-title"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-[var(--bg-card)] border border-red-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle size={18} className="text-red-400" />
              </div>
              <h3 id="confirm-delete-title" className="text-base font-semibold text-[var(--text-1)]">
                Delete &quot;{confirmDelete.name}&quot;?
              </h3>
            </div>
            <p className="text-sm text-[var(--text-2)] mb-2 leading-relaxed">
              This will delete the segment and its{" "}
              <span className="font-semibold text-red-400">
                {confirmDelete.total_count.toLocaleString()} phone{confirmDelete.total_count === 1 ? "" : "s"}
              </span>.
            </p>
            <p className="text-xs text-[var(--text-3)] mb-5 leading-relaxed">
              Source campaign outcomes are not affected — you can always carve a new segment from the same campaign later.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteSegment}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-medium transition"
              >
                <Trash2 size={14} /> Delete segment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function StatCard({
  label, value, icon,
}: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold">
        {icon} {label}
      </div>
      <div className="mt-2 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function SegmentDetailPanel({
  detail, loading, now, loadingMore, onLaunch, onLoadMore, onDelete,
}: {
  detail: SegmentDetail;
  loading: boolean;
  now: Date;
  loadingMore: boolean;
  onLaunch: (id: string) => void;
  onLoadMore: () => void;
  onDelete: (segment: SegmentRow) => void;
}) {
  const { segment, numbers } = detail;
  return (
    <>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight truncate">{segment.name}</h2>
          <p className="text-xs text-[var(--text-3)] mt-0.5 inline-flex items-center gap-1.5 flex-wrap">
            <Megaphone size={10} />
            <span className="truncate max-w-[280px]">
              {segment.source_campaign_name ?? "Unknown campaign"}
            </span>
            <span>·</span>
            <Clock size={10} />
            <span>{formatRelative(segment.created_at, now)}</span>
            {segment.dnc_scrubbed && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <ShieldCheck size={10} /> DNC-scrubbed
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={() => onDelete(segment)}
            title="Delete segment"
            aria-label="Delete segment"
            className="inline-flex items-center justify-center w-8 h-8 text-[var(--text-3)] hover:text-red-400 rounded-lg border border-[var(--border)] hover:border-red-500/30 hover:bg-red-500/[0.06] transition"
          >
            <Trash2 size={12} />
          </button>
          <button
            type="button"
            onClick={() => onLaunch(segment.id)}
            disabled={segment.total_count === 0}
            title={segment.total_count === 0 ? "Segment is empty" : "Open wizard with this segment prefilled"}
            className="inline-flex items-center gap-1.5 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:bg-[var(--bg-elevated)] disabled:text-[var(--text-3)] disabled:cursor-not-allowed px-3 py-1.5 rounded-lg transition font-medium shadow-md shadow-blue-600/20 disabled:shadow-none"
          >
            <Phone size={11} /> Launch campaign
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap mb-4">
        {segment.outcomes_included.map((o) => (
          <span
            key={o}
            className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-mono border ${outcomeBadgeClasses(o)}`}
          >
            {o.replace(/_/g, " ")}
          </span>
        ))}
        <span className="text-[10px] text-[var(--text-3)] font-mono ml-1">
          · {segment.recent_window_days}d recency cutoff
        </span>
      </div>

      {loading && numbers.length === 0 ? (
        <SkeletonRows count={6} />
      ) : numbers.length === 0 ? (
        <EmptyState icon={<Phone size={18} />} message="No numbers in this segment." />
      ) : (
        <div className="border border-[var(--border)] rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--bg-elevated)]">
              <tr>
                <Th>Phone</Th>
                <Th>Source outcome</Th>
                <Th alignRight>Attempts at carve</Th>
              </tr>
            </thead>
            <tbody>
              {numbers.map((n) => (
                <tr key={n.id} className="border-t border-[var(--border)]">
                  <td className="py-2.5 px-3 font-mono text-xs text-[var(--text-1)]">{n.phone_e164}</td>
                  <td className="py-2.5 px-3">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-wider font-mono border ${outcomeBadgeClasses(n.source_outcome)}`}>
                      {n.source_outcome.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-xs text-[var(--text-2)] tabular-nums">
                    {n.source_attempts ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {detail.pagination.hasMore ? (
            <div className="px-3 py-2.5 border-t border-[var(--border)] bg-[var(--bg-elevated)]/40 flex items-center justify-between">
              <span className="text-[11px] text-[var(--text-3)]">
                Showing {numbers.length.toLocaleString()} of {segment.total_count.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="inline-flex items-center gap-1.5 text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-50 transition font-medium"
              >
                {loadingMore && <Loader2 size={11} className="animate-spin" />}
                {loadingMore
                  ? "Loading…"
                  : `Load ${Math.min(100, segment.total_count - numbers.length).toLocaleString()} more`}
              </button>
            </div>
          ) : (
            numbers.length > 0 && (
              <div className="px-3 py-2 text-[10px] text-[var(--text-3)] border-t border-[var(--border)] bg-[var(--bg-elevated)]/40 text-center">
                All {numbers.length.toLocaleString()} phone{numbers.length === 1 ? "" : "s"} shown
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function outcomeBadgeClasses(outcome: string): string {
  switch (outcome) {
    case "unreached":
    case "pending_retry":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30";
    case "recently_called_elsewhere":
      return "bg-sky-500/15 text-sky-400 border-sky-500/30";
    case "removed_from_segment":
      return "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]";
    case "declined_offer":
    case "not_interested":
      return "bg-violet-500/15 text-violet-400 border-violet-500/30";
    case "sent_sms":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    default:
      return "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]";
  }
}

function Th({ children, alignRight }: { children: React.ReactNode; alignRight?: boolean }) {
  return (
    <th
      className={`py-2 px-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] ${
        alignRight ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg">
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-3/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-2.5 w-2/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon, message, detail,
}: { icon: React.ReactNode; message: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)]">
        {icon}
      </div>
      <p className="text-xs text-[var(--text-2)] font-medium">{message}</p>
      {detail && <p className="text-[11px] text-[var(--text-3)] max-w-[280px]">{detail}</p>}
    </div>
  );
}

function formatRelative(iso: string, now: Date): string {
  const ageSec = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (ageSec < 60) return `${ageSec}s ago`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h ago`;
  return `${Math.floor(ageSec / 86400)}d ago`;
}
