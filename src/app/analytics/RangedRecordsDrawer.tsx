"use client";

// Ranged drill-down drawer for the Global Performance 3-card grid (Val's mockup, Slice B). Clicking any
// card total / row / sub-row opens THIS drawer below the cards, pre-filtered to that slice (status +
// attempt-outcome [+ smsOnly]) AND scoped by the section's filter bar (range/campaigns/agent/prompt/
// phone). Unlike TodayRecordsDrawer (one day, client-filtered), this fetches a server-paginated PAGE
// from /api/dashboard/records and supports prev/next + a full-set CSV export. Audio/Transcripts are
// deferred to B2 (cross-campaign export). The bar above owns the phone search, so the drawer doesn't
// duplicate it. Mirrors TodayRecordsDrawer's cache-by-query-key pattern (no synchronous setState in the
// fetch effect — loading is derived from the cache) + prev-prop seeding + AbortController + Escape.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X, FileText, ChevronLeft, ChevronRight } from "lucide-react";
import {
  type CallRecord,
  type RecordStatus,
  type AttemptTag,
  ATTEMPT_TAG_LABELS,
} from "@/lib/dashboardAnalytics";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import RecordsTable from "./RecordsTable";
import { DISPO_ORDER, DISPO_LABEL, OUTCOME_ORDER } from "./recordsDisplay";
import { type Filters } from "./GlobalPerformance";

// The slice a clicked stat maps to (semantic — spec §6), same contract as the Today drawer.
export interface DrawerFilter {
  status: RecordStatus | "all";
  outcome: AttemptTag | "reached" | "all";
  smsOnly: boolean;
  title: string;
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

const PAGE_SIZE = 50;

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...DISPO_ORDER.map((s) => ({ value: s, label: DISPO_LABEL[s] })),
];
const OUTCOME_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All attempt outcomes" },
  { value: "reached", label: "Reached (human)" },
  ...OUTCOME_ORDER.map((t) => ({ value: t, label: ATTEMPT_TAG_LABELS[t] })),
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function isoDateTime(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

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
): string {
  const q = new URLSearchParams();
  q.set("range", filters.range);
  if (filters.campaignIds.length) q.set("campaigns", filters.campaignIds.join(","));
  if (filters.agent) q.set("agent", filters.agent);
  if (filters.prompt) q.set("prompt", filters.prompt);
  if (filters.phone.trim()) q.set("phone", filters.phone.trim());
  if (dispo !== "all") q.set("status", dispo);
  if (outcome !== "all") q.set("outcome", outcome);
  if (slice.smsOnly) q.set("smsOnly", "true");
  q.set("offset", String(offset));
  q.set("limit", limit === "all" ? "all" : String(limit));
  return q.toString();
}

// Client CSV from a record set. No "Texted" column (ranged records carry no smsSentToday flag) and no
// Audio/Transcripts (cross-campaign — B2).
function downloadCsv(records: CallRecord[], filename: string) {
  const header = ["#", "Phone", "Status", "Attempt outcomes", "Last attempted (UTC)"];
  const lines = records.map((r, i) => [
    String(i + 1),
    r.phone ?? "",
    DISPO_LABEL[r.status],
    r.attempts.map((a) => ATTEMPT_TAG_LABELS[a.tag]).join(" | "),
    isoDateTime(r.lastAttemptedMs),
  ]);
  const esc = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
  const csv = [header, ...lines].map((row) => row.map(esc).join(",")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function RangedRecordsDrawer({
  filters,
  filter,
  onClose,
}: {
  filters: Filters;
  filter: DrawerFilter | null;
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
    () => (filter ? buildRecordsQuery(filters, filter, dispo, outcome, 0, PAGE_SIZE) : ""),
    [filters, filter, dispo, outcome],
  );
  const [prevScope, setPrevScope] = useState(scopeKey);
  if (scopeKey !== prevScope) {
    setPrevScope(scopeKey);
    setPage(0);
    setError(null);
  }

  const currentKey = filter ? buildRecordsQuery(filters, filter, dispo, outcome, page * PAGE_SIZE, PAGE_SIZE) : "";
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

  // Close on Escape (ref keeps the latest onClose without re-binding the listener).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onExport = useCallback(async () => {
    if (!filter) return;
    setExporting(true);
    setTruncatedNote(null);
    try {
      const query = buildRecordsQuery(filters, filter, dispo, outcome, 0, "all");
      const r = await fetch(`/api/dashboard/records?${query}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: RecordsResponse = await r.json();
      const slug = filter.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      downloadCsv(j.records, `global-${filters.range}-${slug || "records"}.csv`);
      if (j.truncated) setTruncatedNote(`Exported the first ${j.cap.toLocaleString()} of ${j.total.toLocaleString()} — narrow the filter for the rest.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [filters, filter, dispo, outcome]);

  if (!open || !filter) return null;

  const total = data?.total ?? 0;
  const records = data?.records ?? [];
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE + records.length;
  const canPrev = page > 0;
  const canNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
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
        <button
          type="button"
          onClick={onExport}
          disabled={exporting || total === 0}
          className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <FileText size={13} /> {exporting ? "Exporting…" : "CSV export"}
        </button>
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
        ) : loading ? (
          <p className="text-xs text-[var(--text-3)] py-3">Loading records…</p>
        ) : (
          <>
            <RecordsTable records={records} />
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
    </div>
  );
}
