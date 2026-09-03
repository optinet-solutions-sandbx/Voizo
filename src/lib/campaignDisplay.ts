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

// ── Brand (Customer.io workspace) display — VOZ-216 ──────────────────────────
// campaigns_v2.cio_workspace stores the ROUTING LABEL (VOZ-198): a join key held
// byte-for-byte identical to the CUSTOMERIO_WEBHOOK_SIGNING_KEYS /
// CUSTOMERIO_APP_API_KEYS map keys. Never reformat it at rest — only for display.
// NULL/blank = a pre-VOZ-198 row = the default workspace.
//
// Mirrors CIO_DEFAULT_WORKSPACE in lib/customerio.ts, which is server-side (env +
// API-key resolution) and must not reach the client bundle. campaignDisplay.test.ts
// pins the two literals together so neither can drift unnoticed.
export const DEFAULT_BRAND_WORKSPACE = "lucky7even";

// Operator-facing brand names. A workspace missing here still renders (title-cased
// from its label) so a newly-configured brand is never blank on the dashboard —
// add a line only when its marketing spelling differs (e.g. "spinsup" → "SpinsUp").
// Since 2026-09-03 this catalog is also the brand SWITCHER's list: a brand missing here still
// renders in mixed views but cannot be chosen on its own. Roosterbet keeps the spelling the
// fallback already produced, so no existing label moved.
const BRAND_NAMES: Record<string, string> = {
  lucky7even: "Lucky7even",
  fortuneplay: "Fortune Play",
  roosterbet: "Roosterbet",
};

/** Display name for a campaign's brand. null/blank → the default brand. */
export function brandLabel(workspace: string | null | undefined): string {
  const ws = (workspace ?? "").trim().toLowerCase() || DEFAULT_BRAND_WORKSPACE;
  return BRAND_NAMES[ws] ?? ws.charAt(0).toUpperCase() + ws.slice(1);
}

/**
 * Distinct brand names across a set of campaigns, alphabetical — answers "which
 * brands do these numbers cover?" on the aggregate panels (Today's / Global
 * Performance), where a per-row chip has nowhere to live.
 */
export function distinctBrandLabels(workspaces: (string | null | undefined)[]): string[] {
  return [...new Set(workspaces.map(brandLabel))].sort((a, b) => a.localeCompare(b));
}

/** Brand KEY for scoping (the page-level switcher, the dashboard routes): the routing label
 *  normalised the way brandLabel reads it. null/blank → the default brand. */
export function brandKey(workspace: string | null | undefined): string {
  return (workspace ?? "").trim().toLowerCase() || DEFAULT_BRAND_WORKSPACE;
}

/** The brands the switcher offers, catalog order. */
export const BRAND_WORKSPACES: readonly string[] = Object.keys(BRAND_NAMES);

/** Two-letter glyph for a brand name: initials of two words ("Fortune Play" → FP), else the
 *  first letter and first digit ("Lucky7even" → L7), else the first two letters. */
export function brandGlyph(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "";
  if (!w) return "?";
  return (w[0] + (w.match(/\d/)?.[0] ?? w[1] ?? "")).toUpperCase();
}

// Compact, DISTINGUISHING label for legends / breakdowns where many same-offer campaigns
// appear together: leads with the bits that differ (country + run-date) and drops the shared
// offer ("20 NDFS + 300% DepMatch" is constant noise across a campaign family). Falls back to
// the full display when there's no run-date to distinguish by. Pair with formatCampaign().display
// as the on-hover full name.
//
// The 2026-08 naming family is pipe-delimited instead — "Daily Automated Conversion | VOIZO
// REACTIVATION Campaign - AU [| Fortune Play]" — and carries no L7_ offer to parse, so
// formatCampaign can only prepend the country and keep the whole raw name: every row of the
// campaigns filter read "Daily Automated Conversi…" (Val's CRM team, 2026-08-26).
// pipeShortLabel leads with the DISTINCTIVE segment for that family.
const BOILERPLATE_SEG = /^daily\s+automated(\s+conversions?)?$/i;
// Every name in the family ends with the run date, and it lands on a DIFFERENT segment
// depending on the shape ("… - AU (2026-08-20)" vs "… | Daily Automated (2026-08-20)").
// Peel it off the whole name first, so the boilerplate test still recognises its segment,
// then put it back at the end — one position for every shape.
const DATE_STAMP = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/;

// Strip what every campaign in the family shares: the VOIZO vendor prefix, the filler word
// "Campaign", and the country token (rendered separately, and friendly). Splitting on the
// separators also drops the "- AU" dash debris. `cc` is the PARSED country token, so a
// legitimate two-letter word that isn't the country survives.
function cleanSegment(seg: string, cc: string): string {
  return seg
    .replace(/\bvoizo\b/gi, "")
    .replace(/\bcampaigns?\b/gi, "")
    .split(/[\s_]+/)
    // A dash is a SEPARATOR here ("Campaign - AU") but also part of a date
    // ("Fortune Play (2026-08-25)"), so peel it off a token's ends, never split on it.
    .map((t) => t.replace(/^[-\u2013\u00b7]+/, "").replace(/[-\u2013\u00b7]+$/, ""))
    .filter((t) => t && t !== cc)
    .join(" ");
}

// Segments in their original order, boilerplate dropped — so a trailing brand/date segment
// still distinguishes two otherwise-identical runs. "" when nothing distinctive survives,
// which the caller reads as "fall back to the full display".
function pipeShortLabel(name: string): string {
  const cc = parseCountryToken(name);
  const stamp = name.match(DATE_STAMP)?.[1] ?? "";
  const cleaned = name
    .replace(DATE_STAMP, "")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s && !BOILERPLATE_SEG.test(s))
    .map((s) => cleanSegment(s, cc))
    .filter(Boolean);
  if (cleaned.length === 0) return "";
  // Original order: the first surviving segment NAMES the campaign and a brand/date segment
  // trails it. Leading with the LONGEST instead reads backwards on
  // "... | VOIZO RND REG YESTERDAY AU | Fortune Play (2026-08-25)".
  const core = cleaned.join(" · ");
  return stamp ? `${core} (${stamp})` : core;
}

export function campaignShortLabel(rawName: string | null | undefined): string {
  const f = formatCampaign(rawName);
  if (f.runTag && f.country) return `${f.country} · ${f.runTag}`;
  if (f.runTag && f.offer) return `${f.offer} · ${f.runTag}`;
  const piped = (rawName ?? "").includes("|") ? pipeShortLabel(rawName ?? "") : "";
  if (piped) return f.country ? `${f.country} · ${piped}` : piped;
  return f.display;
}

/**
 * Labels for a collapsed GROUP HEADER. Same disambiguation as campaignFilterLabels, plus: when
 * more than one brand is in scope every header names its own brand, even if nothing collided.
 *
 * Why the extra rule — a header is read alone, with no sibling beside it to compare against. The
 * Fortune Play parents carry "Fortune Play" in their own names, so their Lucky7even twins never
 * collided and were left anonymous: ten collapsed rows where some named a brand and some did
 * not (seen on the live page 2026-08-26). One brand in scope adds nothing and stays off.
 */
export function campaignGroupHeaderLabels(parents: LabelableCampaign[]): Map<string, string> {
  const base = campaignFilterLabels(parents);
  const brandOf = new Map(parents.map((p) => [p.id, brandLabel(p.brand)] as const));
  if (new Set(brandOf.values()).size < 2) return base;
  return new Map(
    [...base].map(([id, label]) => {
      const b = brandOf.get(id)!;
      return [id, label.includes(b) ? label : `${label} · ${b}`] as const;
    }),
  );
}

/** WHICH RUN this campaign is, for a row sitting under a parent header that already carries the
 *  country, name and brand: the date stamped in the name, else the legacy L7_ run tag, else the
 *  start date. "" when there is nothing real to show — never a guess. */
export function campaignRunLabel(rawName: string | null | undefined, startAt: string | null): string {
  const stamp = (rawName ?? "").match(DATE_STAMP)?.[1];
  if (stamp) return stamp;
  const tag = formatCampaign(rawName).runTag;
  if (tag) return tag;
  return startAt ? new Date(startAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
}

// The fields the filter labels are derived from — structural, so tests need no full row.
export interface LabelableCampaign {
  id: string;
  name: string;
  brand?: string | null; // cio_workspace; absent on older API deploys
  startAt: string | null;
}

/**
 * Labels for the campaign FILTER (the dropdown options AND the active chips), disambiguated
 * only as far as they have to be.
 *
 * Two campaigns sharing a short label are the same campaign run for two BRANDS — measured
 * 2026-08-26 across a 234-campaign fleet: 33 such pairs, every one starting the same minute,
 * so the start date cannot separate them and brand always can. The date stays as the last
 * resort for a name that carries no run date of its own. Anything still tied after both is a
 * genuine twin (same name, brand and day) and reads identically, exactly as it did before.
 */
export function campaignFilterLabels(camps: LabelableCampaign[]): Map<string, string> {
  const tally = (vals: Iterable<string>) => {
    const m = new Map<string, number>();
    for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const short = new Map(camps.map((c) => [c.id, campaignShortLabel(c.name)] as const));
  const shortCounts = tally(short.values());
  const branded = new Map(
    camps.map((c) => {
      const s = short.get(c.id)!;
      return [c.id, (shortCounts.get(s) ?? 0) > 1 ? `${s} · ${brandLabel(c.brand)}` : s] as const;
    }),
  );
  const brandedCounts = tally(branded.values());
  return new Map(
    camps.map((c) => {
      const b = branded.get(c.id)!;
      if ((brandedCounts.get(b) ?? 0) === 1) return [c.id, b] as const;
      const d = c.startAt ? new Date(c.startAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      return [c.id, d ? `${b} · ${d}` : b] as const;
    }),
  );
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

// The campaign ids belonging to a country, by the SAME best-effort L7_<CC>_ parse that
// formatCampaign uses for display. Single source for the country FILTER across the
// analytics / records / export routes so filter membership can't drift from the dropdown's
// labels. Structural {id,name} arg keeps this free of dashboardAnalytics types (no import cycle).
export function campaignIdsForCountry(
  campaigns: { id: string; name: string | null }[],
  country: string,
): Set<string> {
  return new Set(
    campaigns.filter((c) => formatCampaign(c.name).country === country).map((c) => c.id),
  );
}
