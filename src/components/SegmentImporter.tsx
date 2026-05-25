"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Search, Users, Check, Star } from "lucide-react";
import { usePinnedSegments } from "@/lib/pinnedSegments";
import { parseJsonBody } from "@/lib/jsonBody";

interface Segment {
  id: number;
  name: string;
  type: string;
}

interface Member {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

interface Props {
  /**
   * Called when the operator confirms an import.
   *
   * - segmentId/segmentName are populated when ONE segment is selected
   *   (single-select row click). Persisted as campaigns_v2.segment_id so
   *   Step 5 (Duplicate), Step 6 (Manual segment refresh), and Step 7
   *   (Resume-diff segment membership check) can re-query customer.io.
   * - segmentId/segmentName are NULL when the operator multi-selects via
   *   checkboxes — the resulting phone list unions members from N
   *   segments and there is no single segment to refresh against. The
   *   refresh endpoints reject NULL segment_id with a friendly 400.
   */
  onImport: (
    phones: string[],
    segmentId: number | null,
    segmentName: string | null,
  ) => void;
  /**
   * When true, hides the per-row multi-select checkboxes — operator can
   * only single-select a segment by clicking the row. Default false (both
   * modes shown). Wizard's Step 1 passes `true` when campaignType is
   * "recurring", since recurring rejects multi-segment imports (NULL
   * segmentId breaks the refresh contract per migration 1d).
   */
  singleSelectOnly?: boolean;
}

export default function SegmentImporter({ onImport, singleSelectOnly = false }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // 2026-05-22: per-operator pinned CIO segments. Star icon in row renderer
  // toggles; pinned float to top when no search query is active.
  const [pinnedIds, togglePin] = usePinnedSegments("cio");

  // Multi-select state
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [membersBySegment, setMembersBySegment] = useState<Map<number, Member[]>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());

  // Single-select state (row click without checkbox)
  const [singleSelectedId, setSingleSelectedId] = useState<number | null>(null);
  const [singleSelectedName, setSingleSelectedName] = useState<string | null>(null);
  const [singleMembers, setSingleMembers] = useState<Member[] | null>(null);
  const [singleLoading, setSingleLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  // 2026-05-22: fetch eagerly on mount (used to gate on `expanded`). The
  // pinned-quick-pick chip row above the card needs segment names to resolve
  // pinned IDs, so the list has to be available even before the operator
  // expands the dropdown. One extra network call on Step 1 mount — same call
  // we always made on first expand, just earlier.
  useEffect(() => {
    if (segments !== null) return;
    (async () => {
      try {
        const res = await fetch("/api/customerio/segments");
        if (!res.ok) {
          const body = await parseJsonBody(res);
          setSegmentsError(body.error || `Failed to load segments (${res.status})`);
          return;
        }
        const body = await res.json();
        setSegments(body.segments ?? []);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : "Network error");
      }
    })();
  }, [segments]);

  const filteredSegments = useMemo(() => {
    if (!segments) return [];
    const term = search.trim().toLowerCase();
    const list = term
      ? segments.filter((s) => s.name.toLowerCase().includes(term))
      : segments;
    // 2026-05-22: when there's no active search query, sort pinned-first
    // (preserving inner order). Search wins over pin order so operators
    // always find their query results first.
    const ordered = term
      ? list
      : [...list].sort((a, b) => {
          const aP = pinnedIds.has(String(a.id));
          const bP = pinnedIds.has(String(b.id));
          if (aP === bP) return 0;
          return aP ? -1 : 1;
        });
    return ordered.slice(0, 50);
  }, [segments, search, pinnedIds]);

  // Fetch members for a segment (cached in membersBySegment)
  const fetchSegmentMembers = useCallback(async (segmentId: number): Promise<Member[]> => {
    // Return cached if available
    const cached = membersBySegment.get(segmentId);
    if (cached) return cached;

    setLoadingIds((prev) => new Set(prev).add(segmentId));
    try {
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=200`);
      if (!res.ok) {
        const body = await parseJsonBody(res);
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const body = await res.json();
      const members = body.members ?? [];
      setMembersBySegment((prev) => new Map(prev).set(segmentId, members));
      return members;
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(segmentId);
        return next;
      });
    }
  }, [membersBySegment]);

  // Checkbox toggle — multi-select mode
  // Uses functional setState to avoid stale-closure race when
  // the operator clicks two checkboxes faster than React re-renders.
  async function handleCheckboxToggle(segmentId: number) {
    // Clear single-select state when using checkboxes
    setSingleSelectedId(null);
    setSingleSelectedName(null);
    setSingleMembers(null);
    setMembersError(null);

    const wasChecked = checkedIds.has(segmentId);

    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (wasChecked) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });

    // Fetch members for newly-checked segment (if not cached)
    if (!wasChecked) {
      try {
        await fetchSegmentMembers(segmentId);
      } catch (err) {
        setMembersError(err instanceof Error ? err.message : "Failed to load members");
      }
    }
  }

  // Row click — single-select mode (replaces everything)
  async function handleRowClick(segmentId: number, segmentName: string) {
    // Clear multi-select state
    setCheckedIds(new Set());
    setMembersError(null);

    setSingleSelectedId(segmentId);
    setSingleSelectedName(segmentName);
    setSingleMembers(null);
    setSingleLoading(true);
    try {
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=200`);
      if (!res.ok) {
        const body = await parseJsonBody(res);
        setMembersError(body.error || `Failed to load members (${res.status})`);
        return;
      }
      const body = await res.json();
      setSingleMembers(body.members ?? []);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSingleLoading(false);
    }
  }

  // Determine which members to show and import
  const isMultiMode = checkedIds.size > 0;
  const displayMembers = useMemo(() => {
    if (isMultiMode) {
      const all: Member[] = [];
      const seen = new Set<string>();
      for (const segId of checkedIds) {
        const members = membersBySegment.get(segId) ?? [];
        for (const m of members) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            all.push(m);
          }
        }
      }
      return all;
    }
    return singleMembers;
  }, [isMultiMode, checkedIds, membersBySegment, singleMembers]);

  const membersWithPhone = displayMembers?.filter((m) => m.phone) ?? [];
  const isLoading = isMultiMode ? loadingIds.size > 0 : singleLoading;

  // Summary label
  const selectionLabel = useMemo(() => {
    if (isMultiMode) {
      const names = segments
        ?.filter((s) => checkedIds.has(s.id))
        .map((s) => s.name) ?? [];
      return names.length <= 2 ? names.join(" + ") : `${names.length} segments selected`;
    }
    return singleSelectedName;
  }, [isMultiMode, checkedIds, segments, singleSelectedName]);

  function handleImport() {
    if (!displayMembers) return;
    const phones = displayMembers
      .map((m) => m.phone)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    if (phones.length === 0) return;
    // Single-segment imports carry the segment identity through to the
    // campaign row; multi-segment imports do not (no single source segment).
    const segmentId = isMultiMode ? null : singleSelectedId;
    const segmentName = isMultiMode ? null : singleSelectedName;
    onImport(phones, segmentId, segmentName);
    setExpanded(false);
    setCheckedIds(new Set());
    setSingleSelectedId(null);
    setSingleSelectedName(null);
    setSingleMembers(null);
    setMembersBySegment(new Map());
    setSearch("");
  }

  // 2026-05-22: pinned-segment quick-pick chips. Resolved from the eagerly-
  // fetched segments list. Click a chip → one-shot fetch + onImport (bypasses
  // the row-click preview path which only loads members for inspection).
  const pinnedSegmentList = (segments ?? []).filter((s) => pinnedIds.has(String(s.id)));

  async function handlePinnedChipClick(segmentId: number, segmentName: string) {
    // Reuse loadingIds for visual feedback on the chip (matches the row
    // spinner pattern). The chip click is one-shot — fetch then onImport
    // directly, no preview state to populate.
    setLoadingIds((prev) => {
      const next = new Set(prev);
      next.add(segmentId);
      return next;
    });
    setMembersError(null);
    try {
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=200`);
      if (!res.ok) {
        const body = await parseJsonBody(res);
        setMembersError(body.error || `Failed to load members (${res.status})`);
        return;
      }
      const body = await res.json();
      const members = (body.members ?? []) as Member[];
      const phones = members
        .map((m) => m.phone)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      if (phones.length === 0) {
        setMembersError("Segment has no phone numbers");
        return;
      }
      onImport(phones, segmentId, segmentName);
    } catch (err) {
      setMembersError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(segmentId);
        return next;
      });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {/* H4: top-level membersError so chip-click failures are visible even
          when the importer card is collapsed. The expanded card has its own
          membersError display (line ~470); both render the same state so
          either path surfaces the error. */}
      {membersError && !expanded && (
        <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">
          {membersError}
        </div>
      )}

      {pinnedSegmentList.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)] font-semibold mr-1">Pinned</span>
          {pinnedSegmentList.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => handlePinnedChipClick(s.id, s.name)}
              disabled={loadingIds.has(s.id)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--bg-elevated)] border border-[var(--border)] text-xs text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] disabled:opacity-50 transition-colors max-w-[260px]"
              title={`Import ${s.name}`}
            >
              <Star size={11} className="fill-amber-400 text-amber-400 shrink-0" />
              <span className="truncate">{s.name}</span>
              {loadingIds.has(s.id) && <Loader2 size={10} className="animate-spin shrink-0" />}
            </button>
          ))}
        </div>
      )}

    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] overflow-hidden">
      {/* Header toggle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
          <Users size={14} className="text-indigo-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-[var(--text-1)]">Import from Customer.io</p>
          {selectionLabel && !expanded ? (
            <p className="text-xs text-indigo-400 truncate">{selectionLabel}</p>
          ) : (
            <p className="text-xs text-[var(--text-3)]">Select a segment to import phone numbers</p>
          )}
        </div>
        {expanded ? (
          <ChevronDown size={16} className="text-[var(--text-3)] flex-shrink-0" />
        ) : (
          <ChevronRight size={16} className="text-[var(--text-3)] flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] p-4">
          {/* Loading */}
          {segments === null && !segmentsError && (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--text-3)]">
              <Loader2 size={14} className="animate-spin" />
              Loading segments...
            </div>
          )}

          {/* Error */}
          {segmentsError && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              {segmentsError}
            </div>
          )}

          {segments && (
            <div className="grid gap-3">
              {/* Search */}
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={`Search ${segments.length} segments...`}
                  className="w-full pl-9 pr-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>

              {/* Multi-select hint (hidden in single-select-only mode) */}
              {!singleSelectOnly && checkedIds.size > 0 && (
                <p className="text-xs text-indigo-400">
                  {checkedIds.size} segment{checkedIds.size > 1 ? "s" : ""} checked — numbers will be combined
                </p>
              )}
              {singleSelectOnly && (
                <p className="text-xs text-[var(--text-3)]">
                  Pick exactly one segment — recurring campaigns refresh from a single source.
                </p>
              )}

              {/* Segment list */}
              <div className="max-h-44 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                {filteredSegments.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-[var(--text-3)]">No matching segments</div>
                ) : (
                  filteredSegments.map((s) => {
                    const isChecked = checkedIds.has(s.id);
                    const isSingleSelected = singleSelectedId === s.id && !isMultiMode;
                    const isSegmentLoading = loadingIds.has(s.id);

                    return (
                      <div
                        key={s.id}
                        className={`flex items-center w-full px-3 py-2 text-sm transition-colors border-b border-[var(--border)] last:border-b-0 ${
                          isChecked
                            ? "bg-indigo-500/10"
                            : isSingleSelected
                              ? "bg-blue-500/10"
                              : "hover:bg-[var(--bg-hover)]"
                        }`}
                      >
                        {/* Checkbox — hidden in single-select-only mode */}
                        {!singleSelectOnly && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleCheckboxToggle(s.id); }}
                            className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 mr-2.5 transition-colors ${
                              isChecked
                                ? "bg-indigo-500 border-indigo-500"
                                : "border-[var(--border)] hover:border-indigo-400"
                            }`}
                          >
                            {isChecked && <Check size={10} className="text-white" strokeWidth={3} />}
                          </button>
                        )}

                        {/* Row click = single select */}
                        <button
                          type="button"
                          onClick={() => handleRowClick(s.id, s.name)}
                          className="flex items-center justify-between flex-1 min-w-0 text-left"
                        >
                          <span className={`truncate ${
                            isChecked ? "text-indigo-400" : isSingleSelected ? "text-blue-400" : "text-[var(--text-2)]"
                          }`}>
                            {s.name}
                            {isSegmentLoading && <Loader2 size={10} className="inline ml-1.5 animate-spin" />}
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 ml-2 ${
                            s.type === "dynamic"
                              ? "bg-indigo-500/10 text-indigo-400"
                              : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
                          }`}>{s.type}</span>
                        </button>

                        {/* 2026-05-22: pin/star — operator favorite for the
                            Step 1 source picker. stopPropagation so the
                            star click doesn't also fire row-select. */}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); togglePin(String(s.id)); }}
                          className="ml-2 p-1 text-[var(--text-3)] hover:text-amber-400 transition-colors flex-shrink-0"
                          aria-label={pinnedIds.has(String(s.id)) ? "Unpin segment" : "Pin segment"}
                          title={pinnedIds.has(String(s.id)) ? "Unpin" : "Pin to top"}
                        >
                          <Star
                            size={13}
                            className={pinnedIds.has(String(s.id)) ? "fill-amber-400 text-amber-400" : ""}
                          />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Members loading */}
              {isLoading && (
                <div className="flex items-center justify-center gap-2 py-4 text-sm text-[var(--text-3)]">
                  <Loader2 size={14} className="animate-spin" />
                  Loading people...
                </div>
              )}

              {/* Members error */}
              {membersError && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
                  {membersError}
                </div>
              )}

              {/* Members preview */}
              {displayMembers && !isLoading && (
                <>
                  {displayMembers.length === 0 ? (
                    <p className="text-sm text-[var(--text-3)] text-center py-2">No people in this segment.</p>
                  ) : (
                    <>
                      {/* Summary bar */}
                      <div className="flex items-center justify-between bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                        <div>
                          <p className="text-sm text-[var(--text-1)] font-medium">{selectionLabel}</p>
                          <p className="text-xs text-[var(--text-3)] mt-0.5">
                            <span className="text-[var(--text-2)] font-semibold">{membersWithPhone.length}</span> of {displayMembers.length} contacts have phone numbers
                          </p>
                        </div>
                        {membersWithPhone.length > 0 && (
                          <button
                            type="button"
                            onClick={handleImport}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors shadow-md shadow-blue-600/20"
                          >
                            <Download size={13} />
                            Import {membersWithPhone.length}
                          </button>
                        )}
                      </div>

                      {/* Compact member list */}
                      <div className="max-h-40 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)]">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-[var(--bg-card)] border-b border-[var(--border)]">
                            <tr>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide w-10">#</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Name</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Phone</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Email</th>
                            </tr>
                          </thead>
                          <tbody>
                            {displayMembers.map((m, idx) => (
                              <tr key={m.id} className="border-t border-[var(--border)]">
                                <td className="px-3 py-1.5 text-[var(--text-3)] font-mono">{idx + 1}</td>
                                <td className="px-3 py-1.5 text-[var(--text-2)]">{m.name ?? "—"}</td>
                                <td className={`px-3 py-1.5 font-mono ${m.phone ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}`}>
                                  {m.phone ?? "—"}
                                </td>
                                <td className="px-3 py-1.5 text-[var(--text-3)]">{m.email ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
    </div>
  );
}
