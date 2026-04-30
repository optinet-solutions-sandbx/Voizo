"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Download, Loader2, Search, Users, Check } from "lucide-react";

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
  onImport: (phones: string[]) => void;
}

export default function SegmentImporter({ onImport }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

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

  useEffect(() => {
    if (!expanded || segments !== null) return;
    (async () => {
      try {
        const res = await fetch("/api/customerio/segments");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setSegmentsError(body.error || `Failed to load segments (${res.status})`);
          return;
        }
        const body = await res.json();
        setSegments(body.segments ?? []);
      } catch (err) {
        setSegmentsError(err instanceof Error ? err.message : "Network error");
      }
    })();
  }, [expanded, segments]);

  const filteredSegments = useMemo(() => {
    if (!segments) return [];
    const term = search.trim().toLowerCase();
    const list = term
      ? segments.filter((s) => s.name.toLowerCase().includes(term))
      : segments;
    return list.slice(0, 50);
  }, [segments, search]);

  // Fetch members for a segment (cached in membersBySegment)
  const fetchSegmentMembers = useCallback(async (segmentId: number): Promise<Member[]> => {
    // Return cached if available
    const cached = membersBySegment.get(segmentId);
    if (cached) return cached;

    setLoadingIds((prev) => new Set(prev).add(segmentId));
    try {
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=50`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
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
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=50`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
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
    onImport(phones);
    setExpanded(false);
    setCheckedIds(new Set());
    setSingleSelectedId(null);
    setSingleSelectedName(null);
    setSingleMembers(null);
    setMembersBySegment(new Map());
    setSearch("");
  }

  return (
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

              {/* Multi-select hint */}
              {checkedIds.size > 0 && (
                <p className="text-xs text-indigo-400">
                  {checkedIds.size} segment{checkedIds.size > 1 ? "s" : ""} checked — numbers will be combined
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
                        {/* Checkbox */}
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
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Name</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Phone</th>
                              <th className="text-left px-3 py-2 font-semibold text-[var(--text-3)] uppercase tracking-wide">Email</th>
                            </tr>
                          </thead>
                          <tbody>
                            {displayMembers.map((m) => (
                              <tr key={m.id} className="border-t border-[var(--border)]">
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
  );
}
