// parentEdit — pure validation for the always-on campaign EDIT page's heavier
// fields (2026-07-13, Jas-approved design). Consumed by the PATCH
// /api/campaigns-v2/[id] route alongside normalizeOperatorControls.
//
// Different contract on purpose: normalizeOperatorControls silently DROPS
// invalid values (conditional keys serve deploy-order safety on create), but
// these fields arrive only from deliberate operator edits — an invalid value
// must come back as a 400 the operator can read, never a silent no-op.

import { validateRecurrencePattern, type RecurrencePattern } from "./types/recurrence";

export interface ParentEditFields {
  recurrencePattern?: RecurrencePattern;
  timezone?: string;
  segmentId?: number;
  goalTarget?: number | null;
  smsTemplate?: string | null;
}

export interface ParentEditResult {
  update: Record<string, unknown>;
  /** First validation problem, operator-readable. Set -> update is empty. */
  error?: string;
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function buildParentEditUpdate(f: ParentEditFields): ParentEditResult {
  const update: Record<string, unknown> = {};

  if (f.recurrencePattern !== undefined) {
    const v = validateRecurrencePattern(f.recurrencePattern);
    if (!v.ok) return { update: {}, error: v.errors[0] };
    update.recurrence_pattern = f.recurrencePattern;
  }

  if (f.timezone !== undefined) {
    if (typeof f.timezone !== "string" || !isValidTimezone(f.timezone)) {
      return { update: {}, error: "That timezone is not recognized." };
    }
    update.timezone = f.timezone;
  }

  if (f.segmentId !== undefined) {
    if (!Number.isInteger(f.segmentId) || (f.segmentId as number) <= 0) {
      return { update: {}, error: "Segment id must be a whole number above 0." };
    }
    update.segment_id = f.segmentId;
  }

  if (f.goalTarget !== undefined) {
    if (f.goalTarget === null) {
      update.goal_target = null;
    } else if (!Number.isInteger(f.goalTarget) || f.goalTarget <= 0) {
      return { update: {}, error: "Campaign goal must be a whole number above 0, or empty." };
    } else {
      update.goal_target = f.goalTarget;
    }
  }

  if (f.smsTemplate !== undefined) {
    const t = typeof f.smsTemplate === "string" ? f.smsTemplate.trim() : "";
    update.sms_template = t.length > 0 ? t : null;
  }

  return { update };
}
