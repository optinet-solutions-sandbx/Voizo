"use client";

// Ranged drill-down drawer for the Global Performance 3-card grid (Val's mockup, Slice B). Clicking any
// card total / row / sub-row opens THIS drawer below the cards, pre-filtered to that slice (status +
// attempt-outcome [+ smsOnly]) AND scoped by the section's filter bar (range/campaigns/agent/prompt/
// phone). Unlike TodayRecordsDrawer (one day, client-filtered), this fetches a server-paginated PAGE
// from /api/dashboard/records and supports prev/next + CSV / Audio / Transcripts export (B2) via the
// shared runExport engine over /api/dashboard/export-metadata. The bar above owns the phone search, so the drawer doesn't
// duplicate it. Mirrors TodayRecordsDrawer's cache-by-query-key pattern (no synchronous setState in the
// fetch effect — loading is derived from the cache) + prev-prop seeding + AbortController + Escape.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { X, FileText, Mic, ScrollText, ChevronLeft, ChevronRight } from "lucide-react";
import {
  type CallRecord,
  type RecordStatus,
  type AttemptTag,
  ATTEMPT_TAG_LABELS,
} from "@/lib/dashboardAnalytics";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import RecordsTable from "./RecordsTable";
import { DISPO_ORDER, DISPO_LABEL, OUTCOME_ORDER } from "./recordsDisplay";
import { runExport, type ExportMode, type ExportProgress } from "@/lib/recordsExportEngine";
import type { ExportLead } from "@/lib/exportLeads";
import { type Filters } from "./GlobalPerformance";

// The slice a clicked stat maps to (semantic — spec §6), same contract as the Today drawer.
export interface DrawerFilter {
  status: RecordStatus | "all";
  outcome: AttemptTag | "reached" | "all";
  smsOnly: boolean;
  title: string;
}

// Entity scope override (Slice E Top Performers): when present, REPLACES the bar's campaign/agent/
// prompt/phone dims with a single entity (range still carries over). campaign + prompt are honored by
// the records endpoint directly; baseAgent rides the base-agent filter dimension added in E1.
export interface DrawerScope {
  campaignIds?: string[];
  baseAgent?: string;
  prompt?: string;
}

// Map a clicked total/row to the semantic drawer filter (copied verbatim from the Today mapping so the
// two views classify identically). `card`/`rowKey` come from PerformanceCards.
export function totalFilter(card: "callAttempts" | "reached" | "sms"): DrawerFilter {
  if (card === "reached") return { status: "all", outcome: "reached", smsOnly: false, title: "Reached contacts" };
  if (card === "sms") return { status: "all", outcome: "all", smsOnly: true, title: "SMS sent" };
  return { status: "all", outcome: "all", smsOnly: false, title: "All call records" };
}
export function rowFilter(card: "callAttempts" | "reached" | "sms", rowKey: string, label: string): DrawerFilter {
  const outcome = rowKey as DrawerFilter["outcome"]; // row keys are AttemptTag | "reached"
  const smsOnly = card === "sms";
  const title = smsOnly ? `SMS — ${label.toLowerCase()}` : label;
  return { status: "all", outcome, smsOnly, title };
}

const PAGE_SIZE = 20;

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...DISPO_ORDER.map((s) => ({ value: s, label: DISPO_LABEL[s] })),
];
const OUTCOME_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All attempt outcomes" },
  { value: "reached", label: "Reached (human)" },
  ...OUTCOME_ORDER.map((t) => ({ value: t, label: ATTEMPT_TAG_LABELS[t] })),
];

interface RecordsResponse {
  records: CallRecord[];
  total: number;
  truncated: boolean;
  cap: number;
}

// Build the /api/dashboard/records query from the bar filters + the slice + the drawer's refinement.
function buildRecordsQuery(
  filters: Filters,
  slice: DrawerFilter,
  dispo: RecordStatus | "all",
  outcome: AttemptTag | "reached" | "all",
  offset: number,
  limit: number | "all",
  scope?: DrawerScope,
): string {
  const q = new URLSearchParams();
  // Match the cards' window: a custom from/to pair overrides the preset; else send the range key.
  if (filters.range === "custom" && filters.from && filters.to) {
    q.set("from", filters.from);
    q.set("to", filters.to);
  } else {
    q.set("range", filters.range);
  }
  if (scope) {
    // Entity drill (Top Performers): scope REPLACES the bar's entity dims; range still applies.
    if (scope.campaignIds?.length) q.set("campaigns", scope.campaignIds.join(","));
    if (scope.baseAgent) q.set("baseAgent", scope.baseAgent);
    if (scope.prompt) q.set("prompt", scope.prompt);
  } else {
    if (filters.campaignIds.length) q.set("campaigns", filters.campaignIds.join(","));
    if (filters.country) q.set("country", filters.country);
    if (filters.prompt) q.set("prompt", filters.prompt);
    if (filters.phone.trim()) q.set("phone", filters.phone.trim());
  }
  if (dispo !== "all") q.set("status", dispo);
  if (outcome !== "all") q.set("outcome", outcome);
  if (slice.smsOnly) q.set("smsOnly", "true");
  q.set("offset", String(offset));
  q.set("limit", limit === "all" ? "all" : String(limit));
  return q.toString();
}

export default function RangedRecordsDrawer({
  filters,
  filter,
  scope,
  onClose,
}: {
  filters: Filters;
  filter: DrawerFilter | null;
  scope?: DrawerScope;
  onClose: () => void;
}) {
  const open = filter !== null;
  const [dispo, setDispo] = useState<RecordStatus | "all">("all");
  const [outcome, setOutcome] = useState<AttemptTag | "reached" | "all">("all");
  const [page, setPage] = useState(0);
  // Pages cached per exact query key (mirrors TodayRecordsDrawer): the fetch effect never calls
  // setState synchronously, so `loading` is DERIVED (no state-synced-to-prop effect).
  const [cache, setCache] = useState<Record<string, RecordsResponse>>({});
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [truncatedNote, setTruncatedNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress>({ current: 0, total: 0, stage: "" });
  // Last loaded page — kept so we can show its rows (dimmed) while the NEXT page fetches, instead of
  // collapsing the table to a one-line "Loading…" (which reflows the drawer height and jumps scroll).
  const lastPageRef = useRef<RecordsResponse | undefined>(undefined);

  // Seed the refinement controls from the clicked slice (adjust-state-on-prop-change during render —
  // NOT an effect; see react.dev you-might-not-need-an-effect). Also resets to page 0 on a new slice.
  const [prevFilter, setPrevFilter] = useState(filter);
  if (filter !== prevFilter) {
    setPrevFilter(filter);
    if (filter) {
      setDispo(filter.status);
      setOutcome(filter.outcome);
      setPage(0);
      setError(null);
    }
  }

  // Scope = everything except the page offset. When it changes (bar filters, slice, or the refinement
  // dropdowns), reset to page 0 so we never request an out-of-range offset.
  const scopeKey = useMemo(
    () => (filter ? buildRecordsQuery(filters, filter, dispo, outcome, 0, PAGE_SIZE, scope) : ""),
    [filters, filter, dispo, outcome, scope],
  );
  const [prevScope, setPrevScope] = useState(scopeKey);
  if (scopeKey !== prevScope) {
    setPrevScope(scopeKey);
    setPage(0);
    setError(null);
    lastPageRef.current = undefined; // new filter/slice → don't flash the previous scope's rows
  }

  const currentKey = filter ? buildRecordsQuery(filters, filter, dispo, outcome, page * PAGE_SIZE, PAGE_SIZE, scope) : "";
  const data = currentKey ? cache[currentKey] : undefined;
  const loading = open && !!filter && !data && !error;

  // Fetch the current page once (lazy, cache-guarded, AbortController). No synchronous setState here.
  useEffect(() => {
    if (!open || !filter || !currentKey || cache[currentKey]) return;
    const controller = new AbortController();
    fetch(`/api/dashboard/records?${currentKey}`, { cache: "no-store", signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: RecordsResponse) => {
        setCache((c) => ({ ...c, [currentKey]: j }));
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => controller.abort();
  }, [open, filter, currentKey, cache]);

  // Remember the latest loaded page so the next page's fetch can keep these rows on-screen (dimmed).
  useEffect(() => { if (data) lastPageRef.current = data; }, [data]);

  // Close on Escape (ref keeps the latest onClose without re-binding the listener).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // CSV / Audio / Transcripts export of the FULL filtered set via the shared engine. Fetches
  // ExportLeads (transcript text + recording URLs) from /api/dashboard/export-metadata, then runExport
  // compiles + downloads. Audio inherits the engine's 500-recording cap (throws → shown as an error).
  const runDrawerExport = useCallback(
    async (mode: ExportMode) => {
      if (!filter) return;
      setExporting(true);
      setError(null);
      setTruncatedNote(null);
      setProgress({ current: 0, total: 0, stage: "Fetching export data…" });
      const ctrl = new AbortController();
      try {
        const query = buildRecordsQuery(filters, filter, dispo, outcome, 0, "all", scope);
        const r = await fetch(`/api/dashboard/export-metadata?${query}`, { cache: "no-store", signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j: { leads: ExportLead[]; total: number; truncated: boolean; cap: number } = await r.json();
        if (!j.leads.length) throw new Error("No records match this filter.");
        const slug = filter.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "records";
        const base = `global-${filters.range}-${slug}`;
        const includeSmsCols = filter.smsOnly || outcome === "positive" || outcome === "all";
        await runExport({
          leads: j.leads,
          mode,
          includeSmsCols,
          filename: (m) => (m === "transcripts" ? `${base}_transcripts.zip` : m === "csv" ? `${base}.csv` : `${base}.zip`),
          signal: ctrl.signal,
          onProgress: setProgress,
        });
        if (j.truncated) setTruncatedNote(`Exported the first ${j.cap.toLocaleString()} of ${j.total.toLocaleString()} — narrow the filter for the rest.`);
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Export failed");
      } finally {
        setExporting(false);
      }
    },
    [filters, filter, dispo, outcome, scope],
  );

  if (!open || !filter) return null;

  // Fall back to the last loaded page while the next one fetches — keeps the table height stable.
  const shownData = data ?? lastPageRef.current;
  const total = shownData?.total ?? 0;
  const records = shownData?.records ?? [];
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE + records.length;
  const canPrev = page > 0;
  const canNext = (page + 1) * PAGE_SIZE < total;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-elevated)]/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-[var(--text-3)] shrink-0" />
          <span className="text-sm font-semibold text-[var(--text-1)] truncate">{filter.title}</span>
          <span className="text-[11px] text-[var(--text-3)] shrink-0">· last {filters.range}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors shrink-0"
        >
          <X size={12} /> Close
        </button>
      </div>

      {/* Toolbar: CSV export + status/outcome refinement (phone search lives on the bar above) */}
      <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 border-b border-[var(--border)]">
        {[
          { mode: "csv" as const, label: "CSV", icon: <FileText size={13} /> },
          { mode: "audio" as const, label: "Audio", icon: <Mic size={13} /> },
          { mode: "transcripts" as const, label: "Transcripts", icon: <ScrollText size={13} /> },
        ].map((b) => (
          <button
            key={b.mode}
            type="button"
            onClick={() => runDrawerExport(b.mode)}
            disabled={exporting || total === 0}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {b.icon} {b.label}
          </button>
        ))}
        {exporting && <span className="text-[11px] text-[var(--text-3)]">{progress.stage || "Exporting…"}</span>}
        <span className="w-px h-4 bg-[var(--border)] mx-0.5" />
        <div className="w-[160px]">
          <StyledSelect size="sm" value={dispo} onChange={(v) => setDispo(v as RecordStatus | "all")} options={STATUS_DROPDOWN} />
        </div>
        <div className="w-[190px]">
          <StyledSelect size="sm" value={outcome} onChange={(v) => setOutcome(v as AttemptTag | "reached" | "all")} options={OUTCOME_DROPDOWN} />
        </div>
        {truncatedNote && <span className="text-[11px] text-amber-400">{truncatedNote}</span>}
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {error ? (
          <p className="text-xs text-amber-400 font-mono py-3">{error}</p>
        ) : loading && records.length === 0 ? (
          <p className="text-xs text-[var(--text-3)] py-3">Loading records…</p>
        ) : (
          <>
            <div className={loading ? "opacity-50 transition-opacity" : "transition-opacity"}>
              <RecordsTable records={records} />
            </div>
            <div className="flex items-center justify-between gap-3 mt-2.5">
              <p className="text-[11px] text-[var(--text-3)]">
                Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} contacts
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => { setPage((p) => Math.max(0, p - 1)); setError(null); }}
                  disabled={!canPrev}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={12} /> Prev
                </button>
                <button
                  type="button"
                  onClick={() => { setPage((p) => p + 1); setError(null); }}
                  disabled={!canNext}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight size={12} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
