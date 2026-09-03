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
// Relative on purpose: this file has unit tests, and vitest does not resolve the `@/` alias.
import { DEFAULT_BRAND_WORKSPACE } from "../../lib/campaignDisplay";

/** campaigns_v2.cio_workspace as a grouping key. null/blank is a pre-VOZ-198 row and means the
 *  DEFAULT brand, the same rule brandLabel() applies, so a null row groups with Lucky7even and
 *  its chip reads Lucky7even, never "Default" (found live 2026-09-03). */
const brandKey = (ws: string | null | undefined) => (ws ?? "").trim().toLowerCase() || DEFAULT_BRAND_WORKSPACE;

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
  /** A bare run row, no header: under Group: None every row, under Family only a ONE-OFF (a run
   *  with no family). A family that ran once in the window keeps its header like the rest
   *  (Jasiel 2026-09-03); a raw run name among family labels read as an odd campaign. */
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
    case "brand": return brandKey(r.cioWorkspace);
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
    single: facet === "none" || (facet === "family" && key.startsWith("solo:")),
    attempts: list.reduce((s, r) => s + r.attempts, 0),
    conversations: list.reduce((s, r) => s + r.conversations, 0),
    sms: list.reduce((s, r) => s + r.sms, 0),
    // the group is as alive as its liveliest run
    status: list.reduce<"running" | "paused" | "finished">((acc, r) => {
      const st = r.displayStatus === "scheduled" ? "paused" : r.displayStatus;
      return STATUS_RANK[st] < STATUS_RANK[acc] ? st : acc;
    }, "finished"),
    brands: [...new Set(list.map((r) => brandKey(r.cioWorkspace)))],
  }));
}

/**
 * "run N of M" for runs that cannot otherwise be told apart (mockup, 2026-09-01): same brand,
 * same country, same family, same UTC start day. A recurring campaign normally spawns once a
 * day, so two on one day is a re-spawn, and the row's title, chips and run window all read
 * identically for the pair. Anything that does not repeat gets "" and is never numbered: a lone
 * run labelled "run 1 of 1" is clutter. Counted over EVERY run handed in, never the page on
 * screen, so narrowing a filter cannot silently unnumber one twin. A run with no startAt has
 * no day and is never numbered rather than guessed.
 */
export function runOrdinals(rows: GroupableRow[]): Map<string, string> {
  const dayOf = (r: GroupableRow) => {
    const t = r.startAt ? Date.parse(r.startAt) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  };
  const keyOf = (r: GroupableRow) => {
    const day = dayOf(r);
    return day ? `${brandKey(r.cioWorkspace)}|${r.country}|${r.parentCampaignId ?? `solo:${r.id}`}|${day}` : null;
  };
  const count = new Map<string, number>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k) count.set(k, (count.get(k) ?? 0) + 1);
  }
  // number in start order, so "run 1" is the earlier of the two
  const ordered = [...rows].sort((a, b) => (Date.parse(a.startAt ?? "") || 0) - (Date.parse(b.startAt ?? "") || 0));
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  for (const r of ordered) {
    const k = keyOf(r);
    const total = k ? count.get(k) ?? 0 : 0;
    if (!k || total < 2) { out.set(r.id, ""); continue; }
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    out.set(r.id, `run ${n} of ${total}`);
  }
  return out;
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

/**
 * The PLAY a family runs (mockup's family chips: Reactivation / Daily Conversion / STEVIC),
 * derived from the family's header label, which reads "Australia · REACTIVATION · Fortune Play":
 * drop the leading country and the trailing brand and what is left names the play, the same
 * across brands and markets. "" when nothing is left, so the caller can skip the chip.
 */
export function playOf(label: string, country: string, brand: string): string {
  const parts = label.split(" · ").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1 && parts[0].toLowerCase() === country.toLowerCase()) parts.shift();
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === brand.toLowerCase()) parts.pop();
  return parts.join(" · ");
}
