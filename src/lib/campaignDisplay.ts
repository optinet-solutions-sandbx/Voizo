// PURE display helpers for campaign names. Turns the raw L7_ code
// ("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_28/0") into a friendly
// "Australia · 20 NDFS + 300% DepMatch" for the dashboard. Best-effort + tested;
// falls back to a cleaned name when the offer can't be parsed.
import { parseCountryToken } from "./campaignAnalytics";

const COUNTRY_NAMES: Record<string, string> = {
  AU: "Australia", CA: "Canada", US: "United States", NZ: "New Zealand",
  PH: "Philippines", GB: "United Kingdom", UK: "United Kingdom", IE: "Ireland",
  IT: "Italy", DE: "Germany", DK: "Denmark", FR: "France", FI: "Finland",
  NO: "Norway", SE: "Sweden", ES: "Spain", GR: "Greece", AE: "UAE",
  ZA: "South Africa", IN: "India", GI: "Gibraltar",
};

export interface CampaignDisplay {
  country: string; // friendly country ("Australia"), or "" if unknown
  offer: string; // humanized offer ("20 NDFS + 300% DepMatch"), or "" if none parsed
  runTag: string; // trailing run/date identifier ("28/0", "11/06/2026") — keeps same-offer campaigns distinct
  display: string; // "Australia · 20 NDFS + 300% DepMatch · 28/0" (cleaned-name fallback)
}

// The trailing run/date suffix (e.g. "_28/0", "_11/06/2026") — the bit that distinguishes
// two otherwise-identical campaign names.
const RUN_TAG = /[_\s]+(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*$/;

function countryOf(name: string): string {
  const region = name.match(/(?:^|[_\s])(GCC|UAE|MENA)(?=[_\s]|$)/i);
  if (region) return region[1].toUpperCase();
  const token = parseCountryToken(name);
  return token !== "UNKNOWN" ? (COUNTRY_NAMES[token] ?? token) : "";
}

// Pull known reward patterns out of the raw code, wherever they appear, and humanize.
function parseOffer(name: string): string {
  const parts: string[] = [];
  const spins = name.match(/(\d+)\s*SPINS?/i);
  if (spins) parts.push(`${spins[1]} Spins`);
  const ndfs = name.match(/(\d+)?\s*NDFS/i);
  if (ndfs) parts.push(ndfs[1] ? `${ndfs[1]} NDFS` : "NDFS");
  const dep = name.match(/(\d+)\s*%?\s*DEP\s*-?\s*MATCH/i);
  if (dep) parts.push(`${dep[1]}% DepMatch`);
  const bonus = name.match(/(\d+)\s*%?\s*BONUS/i);
  if (bonus) parts.push(`${bonus[1]}% Bonus`);
  const fs = name.match(/(?:^|[_\s])(\d+)\s*FS(?=[_\s]|$)/i);
  if (fs && !spins) parts.push(`${fs[1]} FS`);
  return parts.join(" + ");
}

function cleanName(name: string): string {
  return name
    .replace(/^L7[_\s]+/i, "")
    .replace(/[_\s]+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/i, "") // trailing _DD/MM(/YYYY) or _28/0
    .replace(/_/g, " ")
    .trim();
}

export function formatCampaign(rawName: string | null | undefined): CampaignDisplay {
  const name = rawName ?? "";
  const country = countryOf(name);
  const offer = parseOffer(name);
  const runTag = name.match(RUN_TAG)?.[1] ?? "";
  const tail = offer || cleanName(name);
  const base = country ? (tail ? `${country} · ${tail}` : country) : tail || name;
  const display = runTag ? `${base} · ${runTag}` : base;
  return { country, offer, runTag, display };
}

// Compact, DISTINGUISHING label for legends / breakdowns where many same-offer campaigns
// appear together: leads with the bits that differ (country + run-date) and drops the shared
// offer ("20 NDFS + 300% DepMatch" is constant noise across a campaign family). Falls back to
// the full display when there's no run-date to distinguish by. Pair with formatCampaign().display
// as the on-hover full name.
export function campaignShortLabel(rawName: string | null | undefined): string {
  const f = formatCampaign(rawName);
  if (f.runTag && f.country) return `${f.country} · ${f.runTag}`;
  if (f.runTag && f.offer) return `${f.offer} · ${f.runTag}`;
  return f.display;
}

// Compose a prompt's display label by leading with its base-agent NAME (the reliable persona —
// resolved client-side via useBaseAgentNames; prompts themselves carry no parseable name) followed
// by the server's de-boilerplated snippet+sha (see dashboardAnalytics.promptLabel). Falls back to
// the snippet alone when the name is unknown/blank. Shared by the prompt table, Best-Prompt card,
// and the prompt filter so all three read identically.
export function promptAgentLabel(baseName: string | null | undefined, snippetLabel: string): string {
  const name = baseName?.trim();
  return name ? `${name} · ${snippetLabel}` : snippetLabel;
}
