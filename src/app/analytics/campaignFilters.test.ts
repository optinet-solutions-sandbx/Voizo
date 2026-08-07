import { describe, expect, it } from "vitest";
import {
  agentKeyOf, anyCampaignFilterActive, brandKeyOf, matchesCampaignFilters, scriptKeyOf,
  DEFAULT_BRAND_KEY, NO_CAMPAIGN_FILTERS, NO_SCRIPT, type FilterableCampaign,
} from "./campaignFilters";

const row = (over: Partial<FilterableCampaign> = {}): FilterableCampaign => ({
  country: "Australia",
  cioWorkspace: "fortuneplay",
  baseAssistantId: "base_1",
  voiceId: "voice_1",
  scriptId: "script_1",
  ...over,
});

describe("campaignFilters — Campaign Performance section (Val 2026-08-07)", () => {
  it("no filters match everything", () => {
    expect(matchesCampaignFilters(row(), NO_CAMPAIGN_FILTERS)).toBe(true);
    expect(anyCampaignFilterActive(NO_CAMPAIGN_FILTERS)).toBe(false);
  });

  it("country narrows by the parsed country token", () => {
    expect(matchesCampaignFilters(row(), { ...NO_CAMPAIGN_FILTERS, country: "Australia" })).toBe(true);
    expect(matchesCampaignFilters(row(), { ...NO_CAMPAIGN_FILTERS, country: "Canada" })).toBe(false);
  });

  it("brand is multi-select; NULL workspace maps to the default-brand key", () => {
    const f = { ...NO_CAMPAIGN_FILTERS, brands: ["fortuneplay", DEFAULT_BRAND_KEY] };
    expect(matchesCampaignFilters(row(), f)).toBe(true);
    expect(matchesCampaignFilters(row({ cioWorkspace: null }), f)).toBe(true); // default brand selected
    expect(matchesCampaignFilters(row({ cioWorkspace: "roosterbet" }), f)).toBe(false);
    expect(brandKeyOf({ cioWorkspace: null })).toBe(DEFAULT_BRAND_KEY);
  });

  it("agent keys on base assistant, falling back to voice — the row-chip identity", () => {
    expect(agentKeyOf(row())).toBe("base_1");
    expect(agentKeyOf(row({ baseAssistantId: null }))).toBe("voice_1");
    expect(matchesCampaignFilters(row(), { ...NO_CAMPAIGN_FILTERS, agent: "base_1" })).toBe(true);
    expect(matchesCampaignFilters(row({ baseAssistantId: null }), { ...NO_CAMPAIGN_FILTERS, agent: "voice_1" })).toBe(true);
    expect(matchesCampaignFilters(row(), { ...NO_CAMPAIGN_FILTERS, agent: "voice_1" })).toBe(false); // base wins over voice
  });

  it("script filter includes the explicit no-script bucket (snapshot rows may omit the field)", () => {
    expect(matchesCampaignFilters(row(), { ...NO_CAMPAIGN_FILTERS, script: "script_1" })).toBe(true);
    expect(matchesCampaignFilters(row({ scriptId: null }), { ...NO_CAMPAIGN_FILTERS, script: NO_SCRIPT })).toBe(true);
    expect(matchesCampaignFilters(row({ scriptId: undefined }), { ...NO_CAMPAIGN_FILTERS, script: NO_SCRIPT })).toBe(true);
    expect(scriptKeyOf({ scriptId: undefined })).toBe(NO_SCRIPT);
  });

  it("filters AND together", () => {
    const f = { country: "Australia", brands: ["fortuneplay"], agent: "base_1", script: "script_1" };
    expect(matchesCampaignFilters(row(), f)).toBe(true);
    expect(matchesCampaignFilters(row({ country: "Canada" }), f)).toBe(false);
  });
});
