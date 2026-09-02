// Collapses the campaigns filter's flat option list into its recurring parents.
//
// WHY: in the default 7-day window every one of the 63 options is a daily child of just 10
// recurring parents (measured 2026-08-26 over the live fleet: 258 live campaigns, 164 with a
// parent_campaign_id, 10 distinct parents, 6-31 children each). Listing them flat means an
// operator scrolls 63 near-identical rows to reach one campaign family.
//
// The dashboard only ever lists CHILDREN — a recurring parent has no calls of its own and
// prints 0/0/0/0 — so a parent here is a HEADER, never a selectable campaign id. Selecting a
// group means selecting its children's ids; sending the parent's own id to the filter would
// return nothing.

/** One selectable campaign (a child, or a one-off with no parent). */
export interface GroupableOption {
  value: string; // campaign id
  label: string; // full disambiguated label — what a loose row renders
  search: string; // label + raw name, what a keyword is matched against
  parentId?: string | null; // campaigns_v2.parent_campaign_id
  runLabel: string; // this run's date ("2026-08-26"), "" when the name carries none
}

export interface CampaignGroup {
  key: string; // the parent's campaign id
  label: string; // the parent's own disambiguated label
  options: GroupableOption[]; // its children, newest run first
}

/**
 * `parentLabels` maps parent campaign id -> the label for its header. An option whose parentId
 * is absent from that map falls LOOSE rather than being dropped: the parent may be outside the
 * window, and silently hiding a campaign the KPIs are still counting is the worse failure.
 */
export function groupCampaignOptions(
  options: GroupableOption[],
  parentLabels: Record<string, string>,
): { groups: CampaignGroup[]; loose: GroupableOption[] } {
  const byParent = new Map<string, GroupableOption[]>();
  const loose: GroupableOption[] = [];
  for (const o of options) {
    const pid = o.parentId;
    if (!pid || !(pid in parentLabels)) {
      loose.push(o);
      continue;
    }
    byParent.set(pid, [...(byParent.get(pid) ?? []), o]);
  }
  const groups = [...byParent.entries()]
    .map(([key, opts]) => ({
      key,
      label: parentLabels[key],
      // Newest run first: an operator reaching for "yesterday's run" should not scroll a month.
      options: [...opts].sort((a, b) => b.runLabel.localeCompare(a.runLabel)),
    }))
    // Stable by label, so the list cannot reshuffle between renders.
    .sort((a, b) => a.label.localeCompare(b.label));
  return { groups, loose };
}

/**
 * How many children a group shows before it asks for "show all" (Jasiel 2026-09-01). A recurring
 * real-time campaign spawns one child per day, so widening the window puts dozens under one
 * parent: measured at 90 daily spawns, the open group was 96 dated rows in a box that shows
 * about 7, and a search force-expands every group at once. Seven fills that box exactly once.
 * The cap is DISPLAY, never scope: ticking the parent still selects every run.
 */
export const CHILD_PAGE_SIZE = 7;

/** The children a group renders: all of them once the operator asked, else the first page. */
export function visibleChildren<T>(options: T[], showAll: boolean): { shown: T[]; hidden: number } {
  const shown = showAll ? options : options.slice(0, CHILD_PAGE_SIZE);
  return { shown, hidden: options.length - shown.length };
}
