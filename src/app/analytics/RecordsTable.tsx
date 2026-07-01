"use client";

// Presentational call-records table, extracted from CallRecords.tsx (2026-06-29) so it can be
// reused by BOTH the per-campaign panel and the Today's Performance drill-down drawer. Pure view:
// it renders the rows it is given (caller owns fetching + filtering + the "Showing N" footer).
//   • Status column = contact DISPOSITION (Successful→"Positive response" / Not Interested / …).
//   • Attempt 1..N = per-call OUTCOME chips (best-effort PROXY; honest meaning in ATTEMPT_TAG_DESC).

import {
  type CallRecord,
  type CallAttempt,
  ATTEMPT_TAG_LABELS,
  ATTEMPT_TAG_COLOR,
  ATTEMPT_TAG_DESC,
} from "@/lib/dashboardAnalytics";
import { Download } from "lucide-react";
import { triggerDownload } from "@/lib/download";
import { DISPO_LABEL, DISPO_COLOR, recordToCsv, recordCsvFilename } from "./recordsDisplay";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Cap attempt columns; a contact with more attempts folds the overflow into the last visible
// column ("+N more"). Keeps the table from sprawling on heavy-retry rosters.
const MAX_ATTEMPT_COLS = 5;

function fmtDateTime(ms: number | null): string {
  if (ms === null) return "—";
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hh}:${mm}`;
}

// Calm muted chip — colored dot + label. `title` adds a native hover tooltip (used to disclose
// the honest meaning of the proxy outcome tags).
function Chip({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex w-fit max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-1)]${title ? " cursor-help" : ""}`}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full opacity-90" style={{ background: color }} />
      {label}
    </span>
  );
}

// One attempt cell: outcome chip + the "+N more" overflow hint on the last visible column.
function AttemptCell({ attempt, overflow }: { attempt: CallAttempt | undefined; overflow: number }) {
  if (!attempt) return <td className="px-3 py-2 text-center text-[var(--text-3)] text-xs">—</td>;
  return (
    <td className="px-3 py-2 align-top">
      <div className="flex flex-col items-start gap-1">
        <Chip label={ATTEMPT_TAG_LABELS[attempt.tag]} color={ATTEMPT_TAG_COLOR[attempt.tag]} title={ATTEMPT_TAG_DESC[attempt.tag]} />
        {overflow > 0 && <span className="text-[10.5px] text-[var(--text-3)]">+{overflow} more</span>}
      </div>
    </td>
  );
}

/** Renders the records it is given. The caller fetches + filters; this is a pure table view.
 *  Dynamic Attempt 1..N columns (widest record, capped at MAX_ATTEMPT_COLS). */
export default function RecordsTable({ records }: { records: CallRecord[] }) {
  let maxAttempts = 0;
  for (const r of records) if (r.attempts.length > maxAttempts) maxAttempts = r.attempts.length;
  maxAttempts = Math.min(maxAttempts, MAX_ATTEMPT_COLS);
  const attemptCols = Array.from({ length: maxAttempts }, (_, i) => i); // 0-based attempt indices
  const colSpan = 4 + maxAttempts; // # · Phone · Status · …attempts… · Last Attempted · Export

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
      {/* table-fixed: # stays narrow (w-10); remaining columns share width evenly. */}
      <table className="table-fixed w-full text-sm min-w-[640px]">
        <thead>
          <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
            <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2 w-10">#</th>
            <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Phone Number</th>
            <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Status</th>
            {attemptCols.map((i) => (
              <th key={i} className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">
                Attempt {i + 1}
              </th>
            ))}
            <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Last Attempted</th>
            <th className="text-right text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2 w-16">Export</th>
          </tr>
        </thead>
        <tbody>
          {records.length === 0 ? (
            <tr>
              <td colSpan={colSpan} className="px-3 py-8 text-center text-xs text-[var(--text-3)]">
                No matching call records.
              </td>
            </tr>
          ) : (
            records.map((r, i) => (
              <tr key={r.campaignNumberId} className="border-b border-[var(--border)] last:border-b-0 align-top">
                <td className="px-3 py-2 text-[var(--text-3)] font-mono text-xs">{i + 1}</td>
                <td className="px-3 py-2 font-mono text-[var(--text-1)] text-xs">{r.phone ?? "—"}</td>
                <td className="px-3 py-2">
                  <Chip label={DISPO_LABEL[r.status]} color={DISPO_COLOR[r.status]} />
                </td>
                {/* Fixed positional columns (Attempt 1..N) never reorder, so the column index IS the
                    stable key (rows are keyed by campaignNumberId above; react-doctor's no-index-key
                    rule targets reorderable item lists). */}
                {attemptCols.map((idx) => {
                  const isLastCol = idx === maxAttempts - 1;
                  const overflow = isLastCol ? Math.max(0, r.attempts.length - maxAttempts) : 0;
                  return <AttemptCell key={`attempt-${idx}`} attempt={r.attempts[idx]} overflow={overflow} />;
                })}
                <td className="px-3 py-2 whitespace-nowrap font-mono text-[var(--text-2)] text-xs">{fmtDateTime(r.lastAttemptedMs)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => triggerDownload(new Blob([recordToCsv(r)], { type: "text/csv;charset=utf-8" }), recordCsvFilename(r))}
                    title="Export this contact as CSV"
                    aria-label={`Export ${r.phone ?? "contact"} as CSV`}
                    className="inline-flex items-center justify-center rounded-md p-1 text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                  >
                    <Download size={13} />
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
