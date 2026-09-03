"use client";

// Global Performance export (dashboard mockup, ported 2026-09-03): the ranged records drawer's
// engine, offered from the section header without drilling in first. Scope = the filter bar's
// window and filters; when no campaigns are picked, the campaigns in scope (the page's brand) are
// sent explicitly, because the records routes know nothing of the brand. CSV with transcripts, the
// audio zip (the engine's own 500-recording cap), or the transcript bundle.
import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { runExport, type ExportMode, type ExportProgress } from "@/lib/recordsExportEngine";
import { MAX_CAMPAIGNS } from "@/lib/rangedRecords";
import type { ExportLead } from "@/lib/exportLeads";
import type { Filters } from "./GlobalPerformance";

const MODES: [ExportMode, string, string][] = [
  ["csv", "CSV", "one row per call, transcript included"],
  ["audio", "Audio", "recordings as a zip, 500 at most"],
  ["transcripts", "Transcripts", "one text file per call, zipped"],
];

// The same query the records drawer sends for a full-set export (buildRecordsQuery, limit=all),
// with the in-scope campaign ids standing in for an empty picker.
export function exportQuery(f: Filters, scopeIds: string[]): string {
  const q = new URLSearchParams();
  if (f.range === "custom" && f.from && f.to) {
    q.set("from", f.from);
    q.set("to", f.to);
  } else {
    q.set("range", f.range);
  }
  const ids = f.campaignIds.length ? f.campaignIds : scopeIds;
  if (ids.length) q.set("campaigns", ids.join(","));
  if (f.country) q.set("country", f.country);
  if (f.prompt) q.set("prompt", f.prompt);
  if (f.phone.trim()) q.set("phone", f.phone.trim());
  q.set("offset", "0");
  q.set("limit", "all");
  return q.toString();
}

export default function GlobalExport({ filters, scopeIds, disabled }: {
  filters: Filters;
  /** In-scope campaign ids under a brand; null under All brands (the routes then see everything). */
  scopeIds: string[] | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => () => ctrl.current?.abort(), []);

  const run = async (mode: ExportMode) => {
    setOpen(false);
    setNote(null);
    // The routes take at most MAX_CAMPAIGNS ids and silently drop the rest: refuse, never truncate.
    if (scopeIds && !filters.campaignIds.length && scopeIds.length > MAX_CAMPAIGNS) {
      setNote(`${scopeIds.length.toLocaleString("en-US")} campaigns in scope, the export takes ${MAX_CAMPAIGNS}. Pick a shorter window or some campaigns.`);
      return;
    }
    const c = new AbortController();
    ctrl.current = c;
    setProgress({ current: 0, total: 0, stage: "Fetching export data…" });
    try {
      const r = await fetch(`/api/dashboard/export-metadata?${exportQuery(filters, scopeIds ?? [])}`, { cache: "no-store", signal: c.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: { leads: ExportLead[]; total: number; truncated: boolean; cap: number } = await r.json();
      if (!j.leads.length) throw new Error("No records in this window.");
      const base = `global-${filters.range === "custom" && filters.from && filters.to ? `${filters.from}_${filters.to}` : filters.range}`;
      await runExport({
        leads: j.leads,
        mode,
        includeSmsCols: true,
        filename: (m) => (m === "transcripts" ? `${base}_transcripts.zip` : m === "csv" ? `${base}.csv` : `${base}.zip`),
        signal: c.signal,
        // the engine may hand an updater, and our state has a null resting value
        onProgress: (p) => setProgress((prev) => (typeof p === "function" ? p(prev ?? { current: 0, total: 0, stage: "" }) : p)),
      });
      if (j.truncated) setNote(`Exported the first ${j.cap.toLocaleString("en-US")} of ${j.total.toLocaleString("en-US")}. Narrow the window for the rest.`);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setNote(e instanceof Error ? e.message : "Export failed");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className="relative flex items-center gap-2">
      {progress && (
        <span className="text-[11px] text-[var(--text-3)] font-mono" role="status">
          {progress.stage}{progress.total > 0 ? ` ${progress.current}/${progress.total}` : ""}
        </span>
      )}
      {note && !progress && <span className="text-[11px] text-amber-400 max-w-[320px]">{note}</span>}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !!progress}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] border border-[var(--border)] text-[12.5px] text-[var(--text-2)] hover:text-[var(--text-1)] hover:border-[var(--border-2)] transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <Download size={13} /> Export
      </button>
      {open && (
        <>
          <button type="button" aria-label="Close export menu" onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div role="menu" className="absolute right-0 top-full mt-1 z-50 w-[260px] rounded-lg border border-[var(--border-2)] bg-[var(--bg-card)] shadow-xl p-1">
            {MODES.map(([mode, label, hint]) => (
              <button
                key={mode}
                type="button"
                role="menuitem"
                onClick={() => run(mode)}
                className="w-full flex flex-col items-start px-2.5 py-1.5 rounded-md text-left hover:bg-[var(--bg-hover)]"
              >
                <span className="text-[13px] text-[var(--text-1)]">{label}</span>
                <span className="text-[11px] text-[var(--text-3)]">{hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
