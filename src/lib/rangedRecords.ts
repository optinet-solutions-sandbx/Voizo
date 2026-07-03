// Pure helpers for the ranged Global records drawer (Slice B). Kept out of the route handler so the
// validation, slice-filtering, and pagination are unit-testable in isolation (Zero-Trust: every
// client param is whitelisted/clamped here; the route never trusts raw input).

import {
  recordIsReached,
  recordHasAttemptOutcome,
  type CallRecord,
  type RecordStatus,
  type AttemptTag,
} from "./dashboardAnalytics";

export const RANGE_DAYS: Record<string, number> = { "7d": 7, "14d": 14, "30d": 30, "60d": 60, "90d": 90 };
export const FULL_SET_CAP = 10_000; // hard ceiling for the CSV/full-set path (matches the export route)
export const MAX_PAGE = 200;
export const MAX_CAMPAIGNS = 500;

// Whitelists — reuse the shared contracts so a schema change to the taxonomy propagates here.
const STATUSES: readonly RecordStatus[] = ["successful", "offer_delivered", "not_interested", "awaiting_retry", "voicemail", "unreached", "wrong_number"];
const OUTCOMES: readonly (AttemptTag | "reached")[] = ["reached", "unreachable", "voicemail", "positive", "declined", "early_hangup", "neutral"];

export interface RecordsParams {
  rangeDays: number;
  campaignIds: string[] | null;
  agent: string | null;
  baseAgent: string | null; // base_assistant_id scope (Top Performers agent drill, Slice E)
  promptSha: string | null;
  phone: string;
  status: RecordStatus | "all";
  outcome: AttemptTag | "reached" | "all";
  smsOnly: boolean;
  offset: number;
  limit: number;
  full: boolean; // CSV/full-set path (limit=all)
}

/** Validate + clamp every query param. Unknown values fall back to safe defaults (never throw). */
export function parseRecordsParams(sp: URLSearchParams): RecordsParams {
  const rangeDays = RANGE_DAYS[sp.get("range") ?? "30d"] ?? 30;

  const campaignsRaw = (sp.get("campaigns") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_CAMPAIGNS);
  const campaignIds = campaignsRaw.length ? campaignsRaw : null;

  const agent = (sp.get("agent") || "").slice(0, 80) || null;
  const baseAgent = (sp.get("baseAgent") || "").slice(0, 80) || null;
  const promptSha = (sp.get("prompt") || "").slice(0, 80) || null;
  const phone = (sp.get("phone") ?? "").replace(/[^\d+]/g, "").slice(0, 24);

  const statusRaw = sp.get("status") ?? "all";
  const status = (STATUSES as readonly string[]).includes(statusRaw) ? (statusRaw as RecordStatus) : "all";

  const outcomeRaw = sp.get("outcome") ?? "all";
  const outcome = (OUTCOMES as readonly string[]).includes(outcomeRaw) ? (outcomeRaw as AttemptTag | "reached") : "all";

  const smsOnly = sp.get("smsOnly") === "true";
  const full = sp.get("limit") === "all";

  const offset = Math.max(0, Math.trunc(Number(sp.get("offset")) || 0));
  const limit = full
    ? FULL_SET_CAP
    : Math.min(MAX_PAGE, Math.max(1, Math.trunc(Number(sp.get("limit")) || 50)));

  return { rangeDays, campaignIds, agent, baseAgent, promptSha, phone, status, outcome, smsOnly, offset, limit, full };
}

/** Apply the clicked slice (status DISPOSITION + attempt OUTCOME + smsOnly) to the aggregated records.
 *  `smsIds` = campaign_number_ids that got a sent|delivered text in the window. Mirrors the
 *  TodayRecordsDrawer client-side filter exactly so the drawer and the cards reconcile. */
export function filterRecordsBySlice(
  records: CallRecord[],
  p: { status: RecordStatus | "all"; outcome: AttemptTag | "reached" | "all"; smsOnly: boolean },
  smsIds: Set<string>,
): CallRecord[] {
  return records.filter((r) => {
    if (p.smsOnly && !smsIds.has(r.campaignNumberId)) return false;
    if (p.status !== "all" && r.status !== p.status) return false;
    if (p.outcome === "reached") {
      if (!recordIsReached(r)) return false;
    } else if (p.outcome !== "all" && !recordHasAttemptOutcome(r, p.outcome)) {
      return false;
    }
    return true;
  });
}

/** Page window + the true (pre-page) total. */
export function paginate<T>(rows: T[], offset: number, limit: number): { page: T[]; total: number } {
  return { page: rows.slice(offset, offset + limit), total: rows.length };
}
