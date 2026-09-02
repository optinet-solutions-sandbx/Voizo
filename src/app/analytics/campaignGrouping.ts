// Campaign Performance grouping (ported from the dashboard mockup, Jasiel 2026-09-02).
//
// The table lists RUNS: a recurring campaign spawns one child a day, so a 7-day window is
// dozens of near-identical rows. Grouping folds them under what they belong to. Pure
// functions, unit-tested; CampaignTable.tsx only renders the result.
//
// A family is a recurring PARENT (campaigns_v2.parent_campaign_id), the same key the campaign
// picker groups by, so both surfaces agree on what a family is. A one-off campaign with no
// parent is a family of one.

import type { SortKey } from "./SortControl";

export type GroupFacet = "family" | "country" | "brand" | "agent" | "script" | "none";

export const GROUP_FACETS: { key: GroupFacet; label: string }[] = [
  { key: "family", label: "Family" },
  { key: "country", label: "Country" },
  { key: "brand", label: "Brand" },
  { key: "agent", label: "Voice agent" },
  { key: "script", label: "Script" },
  { key: "none", label: "None" },
];

/** The slice of a table row the grouping needs. */
export interface GroupableRow {
  id: string;
  name: string;
  country: string;
  cioWorkspace: string | null;
  baseAssistantId: string | null;
  voiceId: string | null;
  scriptId?: string | null;
  scriptName?: string | null;
  parentCampaignId?: string | null;
  // prod's DisplayStatus; "scheduled" is a recurring parent, which never reaches this table
  displayStatus: "running" | "paused" | "finished" | "scheduled";
  startAt: string | null;
  attempts: number;
  conversations: number;
  sms: number;
}

export interface CampaignGroup<R extends GroupableRow> {
  key: string;
  label: string;
  rows: R[];
  /** A group of ONE renders as a bare run row: a header over a single row would say the same
   *  thing twice, and a summary of one row would print the row back at itself (2026-09-01). */
  single: boolean;
  attempts: number;
  conversations: number;
  sms: number;
  status: "running" | "paused" | "finished";
  brands: string[]; // distinct workspaces, for the brand chips on a mixed header
}

export interface GroupLabels {
  /** parent campaign id -> header label (what the picker shows for that family) */
  family: (parentId: string) => string | null;
  brand: (workspace: string | null) => string;
  agent: (row: GroupableRow) => string;
  fallbackName: (row: GroupableRow) => string;
}

function keyOf(r: GroupableRow, facet: GroupFacet): string {
  switch (facet) {
    case "family": return r.parentCampaignId ? `p:${r.parentCampaignId}` : `solo:${r.id}`;
    case "country": return r.country || "—";
    case "brand": return (r.cioWorkspace ?? "").trim().toLowerCase() || "default";
    case "agent": return r.baseAssistantId ?? r.voiceId ?? "unknown";
    case "script": return r.scriptId ?? "none";
    case "none": return r.id;
  }
}

function labelOf(r: GroupableRow, facet: GroupFacet, L: GroupLabels): string {
  switch (facet) {
    case "family": return (r.parentCampaignId && L.family(r.parentCampaignId)) || L.fallbackName(r);
    case "country": return r.country || "Unknown country";
    case "brand": return L.brand(r.cioWorkspace);
    case "agent": return L.agent(r);
    case "script": return r.scriptName ?? (r.scriptId ? r.scriptId : "No script");
    case "none": return L.fallbackName(r);
  }
}

const STATUS_RANK = { running: 0, paused: 1, scheduled: 1, finished: 2 } as const;

/** Fold rows into groups. Rows keep the order they arrive in (already sorted by the caller). */
export function groupCampaignRows<R extends GroupableRow>(rows: R[], facet: GroupFacet, L: GroupLabels): CampaignGroup<R>[] {
  const by = new Map<string, R[]>();
  for (const r of rows) {
    const k = keyOf(r, facet);
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.entries()].map(([key, list]) => ({
    key,
    label: labelOf(list[0], facet, L),
    rows: list,
    single: list.length === 1,
    attempts: list.reduce((s, r) => s + r.attempts, 0),
    conversations: list.reduce((s, r) => s + r.conversations, 0),
    sms: list.reduce((s, r) => s + r.sms, 0),
    // the group is as alive as its liveliest run
    status: list.reduce<"running" | "paused" | "finished">((acc, r) => {
      const st = r.displayStatus === "scheduled" ? "paused" : r.displayStatus;
      return STATUS_RANK[st] < STATUS_RANK[acc] ? st : acc;
    }, "finished"),
    brands: [...new Set(list.map((r) => (r.cioWorkspace ?? "").trim().toLowerCase() || "default"))],
  }));
}

/** Order groups the way the rows are sorted: by the summed metric, or for "newest" by the
 *  newest run inside. Rows inside a group are left in their incoming order. */
export function sortGroups<R extends GroupableRow>(groups: CampaignGroup<R>[], sort: SortKey): CampaignGroup<R>[] {
  const value = (g: CampaignGroup<R>): number => {
    if (sort === "calls") return g.attempts;
    if (sort === "reached") return g.conversations;
    if (sort === "sms") return g.sms;
    // newest: the most recent run start in the group; null/invalid sorts last
    return g.rows.reduce((m, r) => {
      const t = r.startAt ? Date.parse(r.startAt) : NaN;
      return Number.isFinite(t) ? Math.max(m, t) : m;
    }, -1);
  };
  return [...groups].sort((a, b) => value(b) - value(a));
}
