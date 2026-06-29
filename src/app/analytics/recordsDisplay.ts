// Shared display constants for the call-records table + its filters. Lives apart from RecordsTable
// so that component file only exports a component (React Fast Refresh / react-doctor
// only-export-components). Single source for the Status DISPOSITION chips and the per-attempt
// OUTCOME filter order, used by RecordsTable, CallRecords, and TodayRecordsDrawer.
import type { RecordStatus, AttemptTag } from "@/lib/dashboardAnalytics";

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
