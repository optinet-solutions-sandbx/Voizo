// Pure filter predicates for the Campaign Performance section (Val 2026-08-07:
// country / brand / voice-agent / script filters). Lives apart from
// CampaignTable.tsx so the predicates are unit-testable and the component file
// keeps exporting only components (react-doctor only-export-components).

/** Dropdown value for campaigns without a Script Builder script. */
export const NO_SCRIPT = "__none__";
/** Brand key for cio_workspace NULL (the default brand — brandLabel() renders it). */
export const DEFAULT_BRAND_KEY = "__default__";

export interface CampaignFilterState {
  country: string; // "" = all — country display token parsed from the campaign name
  brands: string[]; // brand keys (raw cio_workspace, DEFAULT_BRAND_KEY for null); [] = all
  agent: string; // "" = all — agentKeyOf() value (base assistant, falling back to voice)
  script: string; // "" = all — script_id, or NO_SCRIPT for scriptless campaigns
  name: string; // "" = all — free-text, every whitespace-separated token must appear in the name
}

export const NO_CAMPAIGN_FILTERS: CampaignFilterState = { country: "", brands: [], agent: "", script: "", name: "" };

/** The row fields the predicates read — structural, so tests need no full table row. */
export interface FilterableCampaign {
  name: string;
  country: string;
  cioWorkspace: string | null;
  baseAssistantId: string | null;
  voiceId: string | null;
  scriptId?: string | null; // optional: session snapshots predate the field
}

/** The identity the row's agent chip renders: base assistant first, voice as
 *  fallback — filtering MUST key on the same identity the user sees. */
export function agentKeyOf(r: Pick<FilterableCampaign, "baseAssistantId" | "voiceId">): string {
  return r.baseAssistantId ?? r.voiceId ?? "";
}

export function brandKeyOf(r: Pick<FilterableCampaign, "cioWorkspace">): string {
  return r.cioWorkspace ?? DEFAULT_BRAND_KEY;
}

export function scriptKeyOf(r: Pick<FilterableCampaign, "scriptId">): string {
  return r.scriptId ?? NO_SCRIPT;
}

/** Campaign-name search (Val 2026-08-25). EVERY whitespace-separated token must appear
 *  somewhere in the name, in any order — these names are long and formulaic
 *  ("Daily Automated Conversion | VOIZO RND REG YESTERDAY AU | Fortune Play (2026-08-25)"),
 *  so a contiguous substring match would make "rnd au" find nothing. Token-AND keeps that
 *  useful while staying predictable: narrower query, never more rows. Case-insensitive;
 *  an all-whitespace needle matches everything (it is not a filter).
 */
export function matchesCampaignName(name: string | null | undefined, needle: string): boolean {
  const tokens = needle.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const hay = (name ?? "").toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

export function matchesCampaignFilters(r: FilterableCampaign, f: CampaignFilterState): boolean {
  if (!matchesCampaignName(r.name, f.name)) return false;
  if (f.country && r.country !== f.country) return false;
  if (f.brands.length > 0 && !f.brands.includes(brandKeyOf(r))) return false;
  if (f.agent && agentKeyOf(r) !== f.agent) return false;
  if (f.script && scriptKeyOf(r) !== f.script) return false;
  return true;
}

export function anyCampaignFilterActive(f: CampaignFilterState): boolean {
  return Boolean(f.country || f.brands.length > 0 || f.agent || f.script || f.name.trim());
}
