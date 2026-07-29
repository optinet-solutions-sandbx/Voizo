"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { Building2, ChevronDown, ChevronRight, Download, Loader2, Search, Users, Check, Star } from "lucide-react";
import StyledSelect from "@/components/StyledSelect";
import { usePinnedSegments } from "@/lib/pinnedSegments";
import { parseJsonBody } from "@/lib/jsonBody";
import { nameByE164 } from "@/lib/campaignV2Shared";
import { fetchAllSegmentMembers } from "@/lib/segmentMemberPager";

/** Mirrors CIO_DEFAULT_WORKSPACE in src/lib/customerio.ts (server-only module —
 *  never import it into a client component; the label string is the contract).
 *  Exported for the wizard steps that render brand labels. */
export const DEFAULT_WS = "lucky7even";

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

/** One segment's fetched membership. `complete` = the WHOLE segment was
 *  fetched (pagination reached the last page); false = stopped at the
 *  operator's import limit or the 10k page ceiling. Kept alongside the
 *  members so the summary can be honest about which one it is showing —
 *  the old single-page fetch said "200 of 200" against a 2,071-member
 *  segment because it had no way to know it was looking at a fraction. */
interface FetchedSegment {
  members: Member[];
  complete: boolean;
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
    /** E.164 → raw member name for the imported phones (greet-by-name Ramp 1). */
    names: Record<string, string>,
    /** Which CIO workspace (brand) the segment belongs to (VOZ-201).
     *  null = default workspace. Rides to campaigns_v2.cio_workspace. */
    cioWorkspace: string | null,
  ) => void;
  /**
   * When true, hides the per-row multi-select checkboxes — operator can
   * only single-select a segment by clicking the row. Default false (both
   * modes shown). Wizard's Step 1 passes `true` when campaignType is
   * "recurring", since recurring rejects multi-segment imports (NULL
   * segmentId breaks the refresh contract per migration 1d).
   */
  singleSelectOnly?: boolean;
  /**
   * VOZ-201: PIN the importer to one workspace (edit page passes the
   * campaign's own cio_workspace — an existing campaign must never be
   * silently repointed at another brand). When set, the Brand dropdown is
   * hidden and every fetch browses this workspace. Absent → self-serve mode:
   * a Brand dropdown appears when more than one workspace is configured.
   */
  workspace?: string | null;
}

export default function SegmentImporter({ onImport, singleSelectOnly = false, workspace: workspaceProp }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentsError, setSegmentsError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // ── VOZ-201: workspace (brand) selection ──
  // "" = default workspace (no query param — server browses lucky7even, the
  // pre-VOZ-201 behavior). A concrete label = operator picked that brand.
  const [availableWs, setAvailableWs] = useState<string[] | null>(null);
  const [activeWs, setActiveWs] = useState("");
  /** The workspace every fetch uses: pinned prop wins; "" = default. */
  const effectiveWs = workspaceProp ?? (activeWs || null);
  /** Concrete label for the import payload + pin scoping. */
  const wsLabel = workspaceProp ?? (activeWs || availableWs?.[0] || null);
  /** Query-string suffix for the member fetches ("" for default workspace). */
  const wsQuery = effectiveWs ? `&workspace=${encodeURIComponent(effectiveWs)}` : "";

  // Self-serve mode only: which brands exist (labels only; server never sends
  // keys). Failure → null → no dropdown → default-workspace flow, unchanged.
  useEffect(() => {
    if (workspaceProp != null) return;
    (async () => {
      try {
        const res = await fetch("/api/customerio/workspaces");
        if (!res.ok) return;
        const body = await res.json();
        if (Array.isArray(body.workspaces)) setAvailableWs(body.workspaces);
      } catch {
        // Silent: the picker simply doesn't render and default flow stands.
      }
    })();
  }, [workspaceProp]);

  // 2026-05-22: per-operator pinned CIO segments. Star icon in row renderer
  // toggles; pinned float to top when no search query is active.
  // VOZ-201: pins are scoped per brand (segment ids collide across
  // workspaces); the default workspace keeps the legacy "cio" store so
  // operators' existing pins survive.
  const pinSource = wsLabel && wsLabel !== DEFAULT_WS ? `cio:${wsLabel}` : "cio";
  const [pinnedIds, togglePin] = usePinnedSegments(pinSource);

  // Multi-select state
  const [checkedIds, setCheckedIds] = useState<Set<number>>(new Set());
  const [membersBySegment, setMembersBySegment] = useState<Map<number, FetchedSegment>>(new Map());
  const [loadingIds, setLoadingIds] = useState<Set<number>>(new Set());

  // Operator's per-segment import ceiling. Blank = the whole segment ("whatever
  // number is in Customer.io is the number Voizo imports"). A value (e.g. 1000)
  // caps the fetch AND the import — the load-test knob.
  const [importCapRaw, setImportCapRaw] = useState("");
  const importCap = useMemo(() => {
    const n = parseInt(importCapRaw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [importCapRaw]);

  // Live per-segment fetch counter ("Fetching… N so far") — a 2,000-member
  // segment pages for a couple of minutes at CIO's rate limit; the operator
  // must see motion, not a frozen spinner.
  const [fetchProgress, setFetchProgress] = useState<Map<number, number>>(new Map());
  const progressTotal = useMemo(
    () => [...fetchProgress.values()].reduce((a, b) => a + b, 0),
    [fetchProgress],
  );

  /** Follow the members route's cursor to the segment's end (or importCap).
   *  Throws on any page failure — never returns a silent partial. */
  const pagedMemberFetch = useCallback(async (segmentId: number): Promise<FetchedSegment> => {
    const fetchPage = async (start?: string) => {
      const startQ = start ? `&start=${encodeURIComponent(start)}` : "";
      const res = await fetch(`/api/customerio/segments/${segmentId}/members?limit=200${startQ}${wsQuery}`);
      if (!res.ok) {
        const body = await parseJsonBody(res);
        throw new Error(body.error || `Failed (${res.status})`);
      }
      const body = await res.json();
      return {
        members: (body.members ?? []) as Member[],
        next: (body.next ?? null) as string | null,
      };
    };
    try {
      return await fetchAllSegmentMembers<Member>(fetchPage, {
        cap: importCap,
        onProgress: (n) => setFetchProgress((prev) => new Map(prev).set(segmentId, n)),
      });
    } finally {
      setFetchProgress((prev) => {
        const next = new Map(prev);
        next.delete(segmentId);
        return next;
      });
    }
  }, [wsQuery, importCap]);

  /** Cap applied at USE time, so lowering the limit after a full fetch needs
   *  no refetch and the cache stays as-fetched. */
  const capMembers = useCallback(
    (entry: FetchedSegment | null | undefined): Member[] => {
      const members = entry?.members ?? [];
      return importCap !== null ? members.slice(0, importCap) : members;
    },
    [importCap],
  );

  // Single-select state (row click without checkbox)
  const [singleSelectedId, setSingleSelectedId] = useState<number | null>(null);
  const [singleSelectedName, setSingleSelectedName] = useState<string | null>(null);
  const [singleResult, setSingleResult] = useState<FetchedSegment | null>(null);
  const [singleLoading, setSingleLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  // 2026-05-22: fetch eagerly on mount (used to gate on `expanded`). The
  // pinned-quick-pick chip row above the card needs segment names to resolve
  // pinned IDs, so the list has to be available even before the operator
  // expands the dropdown. One extra network call on Step 1 mount — same call
  // we always made on first expand, just earlier.
  // VOZ-201: re-runs when the brand changes — the list AND every piece of
  // selection/preview state belong to ONE workspace, so a switch clears all
  // of it (a stale cross-brand member cache is exactly the misroute class the
  // workspace split exists to prevent).
  useEffect(() => {
    let cancelled = false;
    setSegments(null);
    setSegmentsError(null);
    setCheckedIds(new Set());
    setMembersBySegment(new Map());
    setSingleSelectedId(null);
    setSingleSelectedName(null);
    setSingleResult(null);
    setMembersError(null);
    (async () => {
      try {
        const res = await fetch(`/api/customerio/segments${effectiveWs ? `?workspace=${encodeURIComponent(effectiveWs)}` : ""}`);
        if (cancelled) return;
        if (!res.ok) {
          const body = await parseJsonBody(res);
          setSegmentsError(body.error || `Failed to load segments (${res.status})`);
          return;
        }
        const body = await res.json();
        if (!cancelled) setSegments(body.segments ?? []);
      } catch (err) {
        if (!cancelled) setSegmentsError(err instanceof Error ? err.message : "Network error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state setters are stable; effectiveWs is the real dependency
  }, [effectiveWs]);

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

  // Fetch a segment's FULL membership (paginated; cached in membersBySegment).
  const fetchSegmentMembers = useCallback(async (segmentId: number): Promise<Member[]> => {
    // Cache is reusable when it holds the whole segment, or already holds at
    // least as many members as the current import limit needs.
    const cached = membersBySegment.get(segmentId);
    if (cached && (cached.complete || (importCap !== null && cached.members.length >= importCap))) {
      return capMembers(cached);
    }

    setLoadingIds((prev) => new Set(prev).add(segmentId));
    try {
      const result = await pagedMemberFetch(segmentId);
      setMembersBySegment((prev) => new Map(prev).set(segmentId, result));
      return result.members;
    } finally {
      setLoadingIds((prev) => {
        const next = new Set(prev);
        next.delete(segmentId);
        return next;
      });
    }
  }, [membersBySegment, importCap, capMembers, pagedMemberFetch]);

  // Checkbox toggle — multi-select mode
  // Uses functional setState to avoid stale-closure race when
  // the operator clicks two checkboxes faster than React re-renders.
  async function handleCheckboxToggle(segmentId: number) {
    // Clear single-select state when using checkboxes
    setSingleSelectedId(null);
    setSingleSelectedName(null);
    setSingleResult(null);
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
    setSingleResult(null);
    setSingleLoading(true);
    try {
      setSingleResult(await pagedMemberFetch(segmentId));
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
        const members = capMembers(membersBySegment.get(segId));
        for (const m of members) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            all.push(m);
          }
        }
      }
      return all;
    }
    return singleResult ? capMembers(singleResult) : null;
  }, [isMultiMode, checkedIds, membersBySegment, singleResult, capMembers]);

  const membersWithPhone = displayMembers?.filter((m) => m.phone) ?? [];
  const isLoading = isMultiMode ? loadingIds.size > 0 : singleLoading;

  // Coverage honesty for the summary bar: is what we're showing the WHOLE
  // segment(s), or a truncation — and if truncated, by what?
  const coverageNote = useMemo(() => {
    const entries: FetchedSegment[] = isMultiMode
      ? [...checkedIds]
          .map((id) => membersBySegment.get(id))
          .filter((e): e is FetchedSegment => e !== undefined)
      : singleResult
        ? [singleResult]
        : [];
    if (entries.length === 0) return null;
    const cappedByLimit =
      importCap !== null && entries.some((e) => e.members.length > importCap || !e.complete);
    if (cappedByLimit) return `first ${importCap!.toLocaleString()} per segment (import limit)`;
    if (entries.some((e) => !e.complete)) return "partial — 10,000-member page ceiling";
    return "full segment";
  }, [isMultiMode, checkedIds, membersBySegment, singleResult, importCap]);

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
    // Empty segments are selectable in single mode: a real-time campaign's
    // audience is future signups, so "0 numbers now" is its correct starting
    // state (Fixed campaigns still fail launch validation without numbers).
    // Multi-mode exists to combine numbers, so empty stays a no-op there.
    if (phones.length === 0 && isMultiMode) return;
    // Single-segment imports carry the segment identity through to the
    // campaign row; multi-segment imports do not (no single source segment).
    const segmentId = isMultiMode ? null : singleSelectedId;
    const segmentName = isMultiMode ? null : singleSelectedName;
    // Greet-by-name Ramp 1: member names keyed by the SAME normalization the
    // insert pipeline stores (nameByE164 ⇄ parsePhoneList), raw as CIO gave them.
    const names = Object.fromEntries(
      nameByE164(
        displayMembers
          .filter((m): m is typeof m & { phone: string } => typeof m.phone === "string" && m.phone.length > 0)
          .map((m) => ({ phone: m.phone, name: m.name ?? null })),
      ),
    );
    onImport(phones, segmentId, segmentName, names, wsLabel);
    setExpanded(false);
    setCheckedIds(new Set());
    setSingleSelectedId(null);
    setSingleSelectedName(null);
    setSingleResult(null);
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
      // Paginated like every other path — the chip imports DIRECTLY (no
      // preview), so a single-page fetch here would silently ship a fraction
      // of the segment into the campaign.
      const { members } = await pagedMemberFetch(segmentId);
      const phones = members
        .map((m) => m.phone)
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      // 0 phones allowed — chips are single-segment; see handleImport.
      // Greet-by-name Ramp 1: same E.164-keyed name map as handleImport.
      const names = Object.fromEntries(
        nameByE164(
          members
            .filter((m): m is Member & { phone: string } => typeof m.phone === "string" && m.phone.length > 0)
            .map((m) => ({ phone: m.phone, name: m.name ?? null })),
        ),
      );
      onImport(phones, segmentId, segmentName, names, wsLabel);
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

      {/* Chip imports run while the card is collapsed — surface the
          pagination progress here or a multi-minute fetch looks frozen. */}
      {!expanded && fetchProgress.size > 0 && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-3)] px-1">
          <Loader2 size={11} className="animate-spin" />
          Fetching members… {progressTotal.toLocaleString()} so far
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
              {/* VOZ-201: Brand picker — self-serve mode only, and only when
                  more than one workspace is configured. Pinned mode (edit
                  page) and single-brand installs never see it. */}
              {workspaceProp == null && availableWs && availableWs.length > 1 && (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-[var(--text-2)] inline-flex items-center gap-1.5 shrink-0">
                    <Building2 size={13} className="text-[var(--text-3)]" />
                    Brand
                  </span>
                  <div className="flex-1 max-w-[16rem]">
                    <StyledSelect
                      size="sm"
                      value={activeWs || availableWs[0]}
                      onChange={(v) => setActiveWs(v)}
                      options={availableWs.map((w) => ({ value: w, label: w }))}
                    />
                  </div>
                </div>
              )}

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

              {/* Import limit — blank = the whole segment. Selection follows
                  CIO pagination to the segment's end, so the count in
                  Customer.io is the count Voizo imports; this knob caps it
                  (e.g. a 1,000-player load test on a 2,071-member segment). */}
              <div className="flex items-center gap-2">
                <label htmlFor="segment-import-limit" className="text-xs font-medium text-[var(--text-2)] shrink-0">
                  Import limit
                </label>
                <input
                  id="segment-import-limit"
                  type="number"
                  min={1}
                  value={importCapRaw}
                  onChange={(e) => setImportCapRaw(e.target.value)}
                  placeholder="all"
                  className="w-24 px-2 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] text-sm text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                />
                <span className="text-[11px] text-[var(--text-3)]">blank = every member in the segment</span>
              </div>

              {/* Live pagination progress — big segments stream in over pages */}
              {fetchProgress.size > 0 && (
                <div className="flex items-center gap-2 text-xs text-[var(--text-3)]">
                  <Loader2 size={12} className="animate-spin" />
                  Fetching members… {progressTotal.toLocaleString()} so far
                </div>
              )}

              {/* Multi-select hint (hidden in single-select-only mode) */}
              {!singleSelectOnly && checkedIds.size > 0 && (
                <p className="text-xs text-indigo-400">
                  {checkedIds.size} segment{checkedIds.size > 1 ? "s" : ""} checked; numbers will be combined
                </p>
              )}
              {singleSelectOnly && (
                <p className="text-xs text-[var(--text-3)]">
                  Pick exactly one segment. Repeating campaigns refresh from a single source.
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
                    <div className="flex items-center justify-between gap-3 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                      <div>
                        <p className="text-sm text-[var(--text-1)] font-medium">No people in this segment yet.</p>
                        {!isMultiMode && singleSelectedId != null && (
                          <p className="text-xs text-[var(--text-3)] mt-0.5">
                            Fine for real-time campaigns — people who join later are the audience.
                          </p>
                        )}
                      </div>
                      {!isMultiMode && singleSelectedId != null && (
                        <button
                          type="button"
                          onClick={handleImport}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors shadow-md shadow-blue-600/20 flex-shrink-0"
                        >
                          <Download size={13} />
                          Use empty segment
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Summary bar */}
                      <div className="flex items-center justify-between bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-4 py-3">
                        <div>
                          <p className="text-sm text-[var(--text-1)] font-medium">{selectionLabel}</p>
                          <p className="text-xs text-[var(--text-3)] mt-0.5">
                            <span className="text-[var(--text-2)] font-semibold">{membersWithPhone.length}</span> of {displayMembers.length} contacts have phone numbers
                            {coverageNote && <span> — {coverageNote}</span>}
                          </p>
                        </div>
                        {(membersWithPhone.length > 0 || !isMultiMode) && (
                          <button
                            type="button"
                            onClick={handleImport}
                            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium transition-colors shadow-md shadow-blue-600/20"
                          >
                            <Download size={13} />
                            {membersWithPhone.length > 0 ? `Import ${membersWithPhone.length}` : "Use segment (0 numbers)"}
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
