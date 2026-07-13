// Always-on campaigns section (post-VOZ-132 ops control, 2026-07-10).
//
// Pure derivation for /campaigns' "Always-on campaigns" section: one row per
// recurring/realtime PARENT plus its LATEST child. The parent/child duality is
// the operator footgun this section exists to remove — pausing today's child
// stops calls today but the parent respawns tomorrow; pausing the parent stops
// tomorrow but today keeps dialing. The section pairs them so the compound
// Stop can handle both.
//
// Client-side on purpose: the campaigns page already loads every campaign row,
// and "latest child" needs no timezone math — the child with the greatest
// start_at IS the operative one (older ones are completed/closed by rollover).

import type { DayOfWeek } from "./types/recurrence";

type CampaignRow = Record<string, unknown>;

const DAY_ORDER: readonly DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_LABEL: Record<DayOfWeek, string> = {
  sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat",
};

/**
 * Compact schedule days for a status sub-line: "Mon, Wed, Fri" (Sun→Sat order),
 * "Every day" for all seven, null when there's nothing to show. Distinct from
 * RecurrenceEditor.summarizeRecurrence (a full sentence) — this is a glanceable
 * chip for the campaigns list, where a recurring parent reads "Scheduled · <days>".
 */
export function formatRecurrenceDays(
  pattern: { days_of_week?: DayOfWeek[] } | null | undefined,
): string | null {
  const days = pattern?.days_of_week;
  if (!days || days.length === 0) return null;
  const present = DAY_ORDER.filter((d) => days.includes(d));
  if (present.length === 0) return null;
  if (present.length === 7) return "Every day";
  return present.map((d) => DAY_LABEL[d]).join(", ");
}

export interface AlwaysOnRow {
  parent: CampaignRow;
  /** Latest non-skipped child by start_at, or null before the first spawn. */
  latestChild: CampaignRow | null;
}

/** Parents shown: running (live schedule) + paused (needs the Resume
 *  affordance). Completed/archived/inactive parents are history, not controls. */
const VISIBLE_PARENT_STATUSES = new Set(["running", "paused"]);

export function deriveAlwaysOnRows(campaigns: CampaignRow[]): AlwaysOnRow[] {
  const parents = campaigns.filter(
    (c) =>
      (c.campaign_type as string) === "recurring" &&
      VISIBLE_PARENT_STATUSES.has((c.status as string) ?? ""),
  );

  const rows = parents.map((parent) => {
    let latestChild: CampaignRow | null = null;
    let latestTs = -Infinity;
    for (const c of campaigns) {
      if ((c.parent_campaign_id as string | null) !== (parent.id as string)) continue;
      if ((c.status as string) === "skipped") continue; // per-day audit rows, never dialable
      const ts = Date.parse((c.start_at as string | null) ?? "");
      if (!Number.isFinite(ts)) continue;
      if (ts > latestTs) {
        latestTs = ts;
        latestChild = c;
      }
    }
    return { parent, latestChild };
  });

  // Running parents first, then by name — stable, glanceable ordering.
  return rows.sort((a, b) => {
    const ar = (a.parent.status as string) === "running" ? 0 : 1;
    const br = (b.parent.status as string) === "running" ? 0 : 1;
    if (ar !== br) return ar - br;
    return ((a.parent.name as string) ?? "").localeCompare((b.parent.name as string) ?? "");
  });
}
