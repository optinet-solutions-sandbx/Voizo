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
}

export const NO_CAMPAIGN_FILTERS: CampaignFilterState = { country: "", brands: [], agent: "", script: "" };

/** The row fields the predicates read — structural, so tests need no full table row. */
export interface FilterableCampaign {
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

export function matchesCampaignFilters(r: FilterableCampaign, f: CampaignFilterState): boolean {
  if (f.country && r.country !== f.country) return false;
  if (f.brands.length > 0 && !f.brands.includes(brandKeyOf(r))) return false;
  if (f.agent && agentKeyOf(r) !== f.agent) return false;
  if (f.script && scriptKeyOf(r) !== f.script) return false;
  return true;
}

export function anyCampaignFilterActive(f: CampaignFilterState): boolean {
  return Boolean(f.country || f.brands.length > 0 || f.agent || f.script);
}
