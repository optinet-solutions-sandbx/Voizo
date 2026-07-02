"use client";

// Inline drill-down drawer for the Today's Performance 3-card redesign (Val's mockup, 2026-06-29).
// Clicking any card total / row / sub-row opens THIS drawer below the cards, pre-filtered to that
// slice (status + attempt-outcome [+ smsOnly]). Fetches the day's records once per day-view and
// filters client-side. Export is CSV-only here (built from the visible records) — Audio/Transcripts
// stay on the per-campaign page because they're campaign-scoped (this view spans all campaigns).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { X, FileText, Mic, ScrollText, Search } from "lucide-react";
import {
  type TodayCallRecord,
  type RecordStatus,
  type AttemptTag,
  ATTEMPT_TAG_LABELS,
  recordHasAttemptOutcome,
  recordIsReached,
} from "@/lib/dashboardAnalytics";
import { runExport, type ExportMode, type ExportProgress } from "@/lib/recordsExportEngine";
import type { ExportLead } from "@/lib/exportLeads";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import RecordsTable from "./RecordsTable";
import { DISPO_ORDER, DISPO_LABEL, OUTCOME_ORDER } from "./recordsDisplay";

// The slice a clicked stat maps to. `outcome` adds a "reached" group (human-conversation attempts)
// on top of the per-attempt tags; `smsOnly` restricts to contacts texted that day (SMS card).
export interface DrawerFilter {
  status: RecordStatus | "all";
  outcome: AttemptTag | "reached" | "all";
  smsOnly: boolean;
  title: string;
}

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...DISPO_ORDER.map((s) => ({ value: s, label: DISPO_LABEL[s] })),
];
const OUTCOME_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All attempt outcomes" },
  { value: "reached", label: "Reached (human)" },
  ...OUTCOME_ORDER.map((t) => ({ value: t, label: ATTEMPT_TAG_LABELS[t] })),
];

export default function TodayRecordsDrawer({
  day,
  filter,
  onClose,
}: {
  day: "today" | "yesterday";
  filter: DrawerFilter | null;
  onClose: () => void;
}) {
  const open = filter !== null;
  // Records cached per day-view (and per preview date). Keyed so switching the toggle refetches once.
  const [cache, setCache] = useState<Record<string, TodayCallRecord[]>>({});
  const [error, setError] = useState<string | null>(null);
  // Export state (CSV/Audio/Transcripts via the shared runExport engine). Day's ExportLeads are
  // lazily fetched + cached per day, then filtered to the visible set.
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({ current: 0, total: 0, stage: "" });
  const [leadCache, setLeadCache] = useState<Record<string, Record<string, ExportLead>>>({});
  // The drawer's own refinement controls, seeded from the clicked slice.
  const [dispo, setDispo] = useState<RecordStatus | "all">("all");
  const [outcome, setOutcome] = useState<AttemptTag | "reached" | "all">("all");
  const [phone, setPhone] = useState("");

  const cacheKey = day;
  const records = cache[cacheKey];

  // Seed the controls from the entry filter whenever a new slice is clicked. Adjust during render
  // (prev-prop compare) rather than in an effect — routing this through useEffect would commit a
  // stale UI for one frame (react.dev: you-might-not-need-an-effect / adjusting state on prop change).
  const [prevFilter, setPrevFilter] = useState(filter);
  if (filter !== prevFilter) {
    setPrevFilter(filter);
    if (filter) {
      setDispo(filter.status);
      setOutcome(filter.outcome);
      setPhone("");
    }
  }

  // Fetch the day's records once per day-view (lazy: only when open + not cached).
  useEffect(() => {
    if (!open || cache[cacheKey]) return;
    const controller = new AbortController();
    fetch(`/api/dashboard/today/records?day=${day}`, { cache: "no-store", signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: { records: TodayCallRecord[] }) => {
        setCache((c) => ({ ...c, [cacheKey]: j.records }));
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => controller.abort();
  }, [open, cacheKey, day, cache]);

  // Close on Escape.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const visible = useMemo(() => {
    if (!records) return [];
    const smsOnly = filter?.smsOnly ?? false;
    return records.filter((r) => {
      if (smsOnly && !r.smsSentToday) return false;
      if (dispo !== "all" && r.status !== dispo) return false;
      if (outcome === "reached") {
        if (!recordIsReached(r)) return false;
      } else if (outcome !== "all" && !recordHasAttemptOutcome(r, outcome)) {
        return false;
      }
      if (phone.trim() && !(r.phone ?? "").includes(phone.trim())) return false;
      return true;
    });
  }, [records, filter, dispo, outcome, phone]);

  // CSV / Audio / Transcripts of the VISIBLE set via the shared runExport engine (event handler — not
  // an effect). Lazily fetch + cache the day's ExportLeads, then map the visible contacts by
  // campaign_number_id so the export matches exactly what's on screen. Audio inherits the engine's
  // 500-recording cap (throws → shown as the error).
  const runDrawerExport = useCallback(
    async (mode: ExportMode) => {
      setExporting(true);
      setError(null);
      setProgress({ current: 0, total: 0, stage: "Fetching export data…" });
      const ctrl = new AbortController();
      try {
        let leadsByNumber = leadCache[day];
        if (!leadsByNumber) {
          const r = await fetch(`/api/dashboard/today/export-metadata?day=${day}`, { cache: "no-store", signal: ctrl.signal });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const j = (await r.json()) as { leadsByNumber?: Record<string, ExportLead> };
          leadsByNumber = j.leadsByNumber ?? {};
          setLeadCache((c) => ({ ...c, [day]: leadsByNumber }));
        }
        const leads = visible.map((rec) => leadsByNumber?.[rec.campaignNumberId]).filter((l): l is ExportLead => !!l);
        if (!leads.length) throw new Error("No records match this filter.");
        const slug = (filter?.title ?? "records").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "records";
        const base = `today-${day}-${slug}`;
        const includeSmsCols = (filter?.smsOnly ?? false) || outcome === "positive" || outcome === "all";
        await runExport({
          leads,
          mode,
          includeSmsCols,
          filename: (m) => (m === "transcripts" ? `${base}_transcripts.zip` : m === "csv" ? `${base}.csv` : `${base}.zip`),
          signal: ctrl.signal,
          onProgress: setProgress,
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Export failed");
      } finally {
        setExporting(false);
      }
    },
    [visible, filter, day, outcome, leadCache],
  );

  if (!open) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="mt-3 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden"
    >
      {/* Header: title + slice badge + close */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-elevated)]/40">
        <div className="flex items-center gap-2 min-w-0">
          <FileText size={14} className="text-[var(--text-3)] shrink-0" />
          <span className="text-sm font-semibold text-[var(--text-1)] truncate">{filter?.title ?? "Call records"}</span>
          <span className="text-[11px] text-[var(--text-3)] shrink-0">· {day === "today" ? "Today" : "Yesterday"}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors shrink-0"
        >
          <X size={12} /> Close
        </button>
      </div>

      {/* Toolbar: CSV export + status/outcome filters + search */}
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
            disabled={exporting || !records || visible.length === 0}
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
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Search number…"
            aria-label="Search by phone number"
            className="pl-8 pr-3 py-2 text-sm rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:border-blue-500 w-[150px]"
          />
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {error ? (
          <p className="text-xs text-amber-400 font-mono py-3">{error}</p>
        ) : !records ? (
          <p className="text-xs text-[var(--text-3)] py-3">Loading records…</p>
        ) : (
          <>
            <RecordsTable records={visible} />
            <p className="text-[11px] text-[var(--text-3)] mt-2">
              Showing {visible.length.toLocaleString()} of {records.length.toLocaleString()} contacts dialed {day === "today" ? "today" : "yesterday"}.
            </p>
          </>
        )}
      </div>
    </motion.div>
  );
}
