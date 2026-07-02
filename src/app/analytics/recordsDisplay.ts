// Shared display constants for the call-records table + its filters. Lives apart from RecordsTable
// so that component file only exports a component (React Fast Refresh / react-doctor
// only-export-components). Single source for the Status DISPOSITION chips and the per-attempt
// OUTCOME filter order, used by RecordsTable, CallRecords, and TodayRecordsDrawer.
import type { RecordStatus, AttemptTag, CallRecord } from "../../lib/dashboardAnalytics";
import { ATTEMPT_TAG_LABELS, recordHasAttemptOutcome } from "../../lib/dashboardAnalytics";
import { csvCell, CSV_BOM } from "../../lib/download";

export const DISPO_ORDER: RecordStatus[] = ["successful", "not_interested", "awaiting_retry", "voicemail", "unreached", "wrong_number"];
export const DISPO_LABEL: Record<RecordStatus, string> = {
  successful: "Positive response", // "Success" retired (Val 2026-06-26) — goal = agreed to the offer SMS, not a sale
  not_interested: "Not Interested",
  awaiting_retry: "Awaiting Retry",
  voicemail: "Voicemail",
  unreached: "Unreached",
  wrong_number: "Wrong Number",
};
export const DISPO_COLOR: Record<RecordStatus, string> = {
  successful: "#5fb39a",
  not_interested: "#cf8a8a",
  awaiting_retry: "#c9a86a",
  voicemail: "#9f90c9",
  unreached: "#8b939c",
  wrong_number: "#8b939c",
};
// Attempt columns + the outcome filter = per-call OUTCOME categories (the AttemptTag set).
export const OUTCOME_ORDER: AttemptTag[] = ["positive", "neutral", "declined", "early_hangup", "voicemail", "unreachable"];

// ── Per-row CSV export (A1) ──────────────────────────────────────────────────
// Serialize ONE contact's visible fields to a self-describing 1-row CSV (BOM + header + row),
// entirely client-side from the already-loaded CallRecord — no fetch, no campaignId needed, so the
// per-row download works in both the per-campaign panel and the cross-campaign drawers. Reuses the
// shared csvCell (RFC-4180 quoting + formula-injection guard) + CSV_BOM so it matches the bulk exports.
export function recordToCsv(record: CallRecord): string {
  const attemptCols = record.attempts.map((_, i) => `Attempt ${i + 1}`);
  const header = ["Phone", "Status", ...attemptCols, "Last Attempted"];
  const row: Array<string | null> = [
    record.phone,
    DISPO_LABEL[record.status],
    ...record.attempts.map((a) => ATTEMPT_TAG_LABELS[a.tag]),
    record.lastAttemptedMs === null ? null : new Date(record.lastAttemptedMs).toISOString(),
  ];
  return `${CSV_BOM}${header.map(csvCell).join(",")}\r\n${row.map(csvCell).join(",")}\r\n`;
}

/** Safe download filename for a single contact's CSV (alphanumerics of phone, else the number id). */
export function recordCsvFilename(record: CallRecord): string {
  const id = (record.phone ?? record.campaignNumberId).replace(/[^0-9A-Za-z]/g, "");
  return `voizo_contact_${id || "record"}.csv`;
}

// ── Records slice filter (camp-row metric click → straight-to-records expand) ─
// A clicked breakdown number on a campaign row maps to one of these slices; CallRecords
// filters by it. `texted.refine` composes SMS-column rows (texted AND that call outcome)
// so the drill-down count reconciles with the row's number — the mockup's shortcut shows
// ALL contacts with the outcome; ours stays true to the column.
export type RecordSlice =
  | { kind: "all" }
  | { kind: "outcome"; tag: AttemptTag }
  | { kind: "reached" }
  | { kind: "texted"; refine?: "reached" | AttemptTag };

// "Reached" = a live human answered — any attempt that connected to a person (not voicemail / no-connect).
const REACHED_TAGS = new Set<AttemptTag>(["positive", "neutral", "declined", "early_hangup"]);
const isReached = (r: CallRecord) => r.attempts.some((a) => REACHED_TAGS.has(a.tag));

export function sliceMatches(r: CallRecord, s: RecordSlice): boolean {
  switch (s.kind) {
    case "all":
      return true;
    case "outcome":
      return recordHasAttemptOutcome(r, s.tag);
    case "reached":
      return isReached(r);
    case "texted":
      if (r.smsSent !== true) return false;
      if (s.refine === undefined) return true;
      return s.refine === "reached" ? isReached(r) : recordHasAttemptOutcome(r, s.refine);
  }
}

// Slice equality — drives the active-highlight + same-number-toggle-close (mockup handleRowClick).
export function sliceEq(a: RecordSlice | null, b: RecordSlice | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "outcome" && b.kind === "outcome") return a.tag === b.tag;
  if (a.kind === "texted" && b.kind === "texted") return (a.refine ?? null) === (b.refine ?? null);
  return true;
}

// ── Metric click → slice mapping (mockup handleRowClick parity) ──────────────
// Maps a BreakdownColumn click (column total or a row/sub-row by its PerfRow key) to the
// slice + badge label. Row keys come from computeWindowPerf: callAttempts rows are
// reached|voicemail|unreachable; reached rows are outcome tags; sms rows mirror
// callAttempts with positive|neutral|declined sub-rows under Reached.
export function metricPickSlice(
  metric: "callAttempts" | "reached" | "sms",
  rowKey?: string,
  rowLabel?: string,
): { slice: RecordSlice; label: string } {
  if (rowKey === undefined) {
    if (metric === "reached") return { slice: { kind: "reached" }, label: "Reached" };
    if (metric === "sms") return { slice: { kind: "texted" }, label: "SMS sent" };
    return { slice: { kind: "all" }, label: "All call records" };
  }
  const label = rowLabel ?? rowKey;
  if (metric === "sms") {
    const refine = rowKey === "reached" ? ("reached" as const) : (rowKey as AttemptTag);
    return { slice: { kind: "texted", refine }, label: `SMS · ${label}` };
  }
  if (rowKey === "reached") return { slice: { kind: "reached" }, label };
  return { slice: { kind: "outcome", tag: rowKey as AttemptTag }, label };
}
