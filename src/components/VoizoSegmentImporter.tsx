"use client";

// 2026-05-22: Step 1 Voizo source picker. Mirrors SegmentImporter's shape
// (search + list + selection + members fetch) but pulls from Voizo's local
// segments (the Audience CRM rows) via /api/audience/segments.
//
// The Voizo source skips features SegmentImporter has that don't apply here:
// no "single-select for recurring" toggle (Voizo segments are static
// snapshots, not dynamic). The pin/star icon and list-sorting behavior match.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Star, Users } from "lucide-react";
import { usePinnedSegments } from "@/lib/pinnedSegments";

interface SegmentRow {
  id: string;
  name: string;
  source_campaign_name: string | null;
  total_count: number;
  created_at: string;
}

interface NumberRow {
  phone_e164: string;
}

interface Props {
  /** Called when the operator selects a segment + we've fetched its phones. */
  onImport: (phones: string[], segmentId: string, segmentName: string) => void;
  /** Pre-selected segment ID (from Audience-tab entry path). Visual only —
   *  doesn't trigger a fetch. */
  selectedId?: string | null;
}

export default function VoizoSegmentImporter({ onImport, selectedId }: Props) {
  const [segments, setSegments] = useState<SegmentRow[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(selectedId ?? null);
  const [phonesError, setPhonesError] = useState<string | null>(null);
  const [phonesLoading, setPhonesLoading] = useState(false);

  const [pinnedIds, togglePin] = usePinnedSegments("voizo");

  // Initial list fetch
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/audience/segments", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as { segments: SegmentRow[] };
        if (cancelled) return;
        setSegments(body.segments ?? []);
      } catch (err) {
        if (cancelled) return;
        setSegmentsError(err instanceof Error ? err.message : "Failed to load segments");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Match selectedId changes from the parent (e.g., page mount sets it).
  useEffect(() => {
    if (selectedId !== undefined) setActiveId(selectedId);
  }, [selectedId]);

  // Filter + sort: search first, then pin order
  const visibleSegments = useMemo(() => {
    if (!segments) return null;
    const q = search.trim().toLowerCase();
    const filtered = q
      ? segments.filter((s) =>
          s.name.toLowerCase().includes(q) ||
          (s.source_campaign_name ?? "").toLowerCase().includes(q),
        )
      : segments;
    if (q) return filtered; // search relevance wins
    return [...filtered].sort((a, b) => {
      const aP = pinnedIds.has(a.id);
      const bP = pinnedIds.has(b.id);
      if (aP === bP) return 0;
      return aP ? -1 : 1;
    });
  }, [segments, pinnedIds, search]);

  const selectSegment = useCallback(
    async (segment: SegmentRow) => {
      setActiveId(segment.id);
      setPhonesError(null);
      setPhonesLoading(true);
      try {
        // Fetch ALL pages — local segments are typically <500 phones,
        // but the API caps per-page at 500. Walk cursor until exhausted.
        // H5: iteration cap (10000 phones max) guards against a buggy server
        // returning hasMore=true with the same cursor — would otherwise hang
        // the browser. Mirrors the cap used in /campaigns/v2/new prefill effect.
        const MAX_PAGES = 20;
        const phones: string[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < MAX_PAGES; i++) {
          const url = `/api/audience/segments/${segment.id}?limit=500${cursor ? `&cursor=${cursor}` : ""}`;
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = (await r.json()) as {
            numbers: NumberRow[];
            pagination: { hasMore: boolean; nextCursor: string | null };
          };
          for (const n of body.numbers ?? []) phones.push(n.phone_e164);
          if (!body.pagination.hasMore || !body.pagination.nextCursor) break;
          cursor = body.pagination.nextCursor;
        }
        onImport(phones, segment.id, segment.name);
      } catch (err) {
        setPhonesError(err instanceof Error ? err.message : "Failed to load segment phones");
      } finally {
        setPhonesLoading(false);
      }
    },
    [onImport],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-[var(--text-3)]">
        <Loader2 size={14} className="animate-spin mr-2" />
        Loading Voizo segments…
      </div>
    );
  }

  if (segmentsError) {
    return (
      <div className="px-3 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-300">
        Couldn&apos;t load Voizo segments: {segmentsError}
      </div>
    );
  }

  if (!segments || segments.length === 0) {
    return (
      <div className="px-3 py-3 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] text-sm text-[var(--text-2)]">
        No Voizo segments yet. Carve one in the{" "}
        <a href="/audience" className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline">
          Audience tab
        </a>{" "}
        first.
      </div>
    );
  }

  // 2026-05-22: pinned-segment quick-pick chips. Click a chip = same selectSegment
  // path as the list row click. Hidden when no pins exist.
  const pinnedSegmentList = (segments ?? []).filter((s) => pinnedIds.has(s.id));

  return (
    <div className="flex flex-col gap-2">
      {pinnedSegmentList.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold mr-1">Pinned</span>
          {pinnedSegmentList.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => selectSegment(s)}
              disabled={phonesLoading && activeId === s.id}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-elevated)] border border-[var(--border)] text-xs text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] disabled:opacity-50 transition-colors max-w-[260px]"
              title={`Import ${s.name}`}
            >
              <Star size={11} className="fill-amber-400 text-amber-400 shrink-0" />
              <span className="truncate">{s.name}</span>
              {phonesLoading && activeId === s.id && <Loader2 size={10} className="animate-spin shrink-0" />}
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Voizo segments by name or source campaign"
          className="w-full pl-7 pr-3 py-2 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-colors"
        />
      </div>

      {/* List */}
      <div className="flex flex-col gap-1 max-h-72 overflow-y-auto pr-1">
        {(visibleSegments ?? []).map((segment) => {
          const isActive = segment.id === activeId;
          const isPinned = pinnedIds.has(segment.id);
          return (
            <div
              key={segment.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm transition-colors ${
                isActive
                  ? "bg-blue-500/15 border border-blue-500/40 text-[var(--text-1)]"
                  : "bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)]"
              }`}
            >
              <button
                type="button"
                onClick={() => selectSegment(segment)}
                className="flex items-center gap-2 flex-1 min-w-0 text-left"
              >
                <Users size={13} className="text-[var(--text-3)] shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{segment.name}</div>
                  <div className="text-[11px] text-[var(--text-3)] truncate">
                    {segment.source_campaign_name && (
                      <>from {segment.source_campaign_name} · </>
                    )}
                    {segment.total_count} phone{segment.total_count === 1 ? "" : "s"}
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin(segment.id);
                }}
                className="p-1 text-[var(--text-3)] hover:text-amber-400 transition-colors flex-shrink-0"
                aria-label={isPinned ? "Unpin segment" : "Pin segment"}
                title={isPinned ? "Unpin" : "Pin to top"}
              >
                <Star
                  size={14}
                  className={isPinned ? "fill-amber-400 text-amber-400" : ""}
                />
              </button>
            </div>
          );
        })}
        {visibleSegments && visibleSegments.length === 0 && (
          <p className="px-3 py-3 text-xs text-[var(--text-3)] text-center">
            No segments match &ldquo;{search}&rdquo;.
          </p>
        )}
      </div>

      {phonesLoading && (
        <div className="flex items-center gap-2 text-xs text-[var(--text-3)]">
          <Loader2 size={12} className="animate-spin" />
          Loading phones…
        </div>
      )}

      {phonesError && (
        <p className="text-xs text-red-400">
          Couldn&apos;t load phones: {phonesError}
        </p>
      )}
    </div>
  );
}
