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

// ── Records slice filter (campaign expand click-to-filter) ───────────────────
// A metric/breakdown click in CampaignSummary maps to one of these slices; CallRecords filters by it.
export type RecordSlice =
  | { kind: "all" }
  | { kind: "outcome"; tag: AttemptTag }
  | { kind: "reached" }
  | { kind: "texted" };

// "Reached" = a live human answered — any attempt that connected to a person (not voicemail / no-connect).
const REACHED_TAGS = new Set<AttemptTag>(["positive", "neutral", "declined", "early_hangup"]);

export function sliceMatches(r: CallRecord, s: RecordSlice): boolean {
  switch (s.kind) {
    case "all":
      return true;
    case "outcome":
      return recordHasAttemptOutcome(r, s.tag);
    case "reached":
      return r.attempts.some((a) => REACHED_TAGS.has(a.tag));
    case "texted":
      return r.smsSent === true;
  }
}

// Slice equality — drives the active-highlight (CampaignSummary) + toggle-close (CampaignExpand).
export function sliceEq(a: RecordSlice | null, b: RecordSlice | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "outcome" && b.kind === "outcome" ? a.tag === b.tag : true;
}
