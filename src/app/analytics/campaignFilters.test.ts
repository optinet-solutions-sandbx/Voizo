import { describe, expect, it } from "vitest";
import {
  agentKeyOf, anyCampaignFilterActive, brandKeyOf, matchesCampaignFilters, matchesCampaignName, scriptKeyOf,
  toggleAllMatching,
  DEFAULT_BRAND_KEY, NO_CAMPAIGN_FILTERS, NO_SCRIPT, type FilterableCampaign,
} from "./campaignFilters";

const row = (over: Partial<FilterableCampaign> = {}): FilterableCampaign => ({
  name: "Daily Automated Conversion | VOIZO RND REG YESTERDAY AU | Fortune Play (2026-08-25)",
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
    const f = { country: "Australia", brands: ["fortuneplay"], agent: "base_1", script: "script_1", name: "" };
    expect(matchesCampaignFilters(row(), f)).toBe(true);
    expect(matchesCampaignFilters(row({ country: "Canada" }), f)).toBe(false);
  });
});

describe("matchesCampaignName — campaign search (Val 2026-08-25)", () => {
  const NAME = "Daily Automated Conversion | VOIZO RND REG YESTERDAY AU | Fortune Play (2026-08-25)";

  it("an empty or whitespace-only needle is not a filter", () => {
    expect(matchesCampaignName(NAME, "")).toBe(true);
    expect(matchesCampaignName(NAME, "   ")).toBe(true);
  });

  it("matches case-insensitively on a contiguous fragment", () => {
    expect(matchesCampaignName(NAME, "fortune play")).toBe(true);
    expect(matchesCampaignName(NAME, "FORTUNE")).toBe(true);
  });

  it("THE POINT: tokens may be out of order and non-adjacent", () => {
    // A contiguous substring match finds nothing here — the words are 4 apart.
    expect(NAME.toLowerCase().includes("rnd au")).toBe(false);
    expect(matchesCampaignName(NAME, "rnd au")).toBe(true);
    expect(matchesCampaignName(NAME, "au rnd")).toBe(true);
  });

  it("EVERY token must appear — one miss rejects the row", () => {
    expect(matchesCampaignName(NAME, "rnd nz")).toBe(false);
    expect(matchesCampaignName(NAME, "reactivation")).toBe(false);
  });

  it("finds a day's runs by the date stamped in the name", () => {
    expect(matchesCampaignName(NAME, "2026-08-25")).toBe(true);
    expect(matchesCampaignName(NAME, "2026-08-24")).toBe(false);
  });

  it("tolerates a missing name rather than throwing", () => {
    expect(matchesCampaignName(null, "rnd")).toBe(false);
    expect(matchesCampaignName(undefined, "")).toBe(true);
  });

  it("a name needle counts as an active filter, so Clear filters appears", () => {
    expect(anyCampaignFilterActive({ ...NO_CAMPAIGN_FILTERS, name: "rnd" })).toBe(true);
    // whitespace-only is not a filter — it must not light up Clear filters
    expect(anyCampaignFilterActive({ ...NO_CAMPAIGN_FILTERS, name: "  " })).toBe(false);
  });

  it("narrows, never widens: a matching row still has to pass the other filters", () => {
    const f = { ...NO_CAMPAIGN_FILTERS, name: "fortune", country: "Canada" };
    expect(matchesCampaignFilters(row(), f)).toBe(false);
  });
});

describe("toggleAllMatching — select/deselect every option the search turned up", () => {
  it("selects them all when none of them is selected yet", () => {
    expect(toggleAllMatching([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("a PARTIAL selection selects the rest — it does not deselect", () => {
    expect(toggleAllMatching(["b"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
  });

  it("deselects them all only once every one of them is selected", () => {
    expect(toggleAllMatching(["a", "b", "c"], ["a", "b", "c"])).toEqual([]);
  });

  it("THE POINT: selections outside the search are never touched, either way", () => {
    // "z" was picked under a different query — selecting all of a-c must keep it.
    expect(toggleAllMatching(["z"], ["a", "b"])).toEqual(["z", "a", "b"]);
    // ...and so must deselecting all of a-b.
    expect(toggleAllMatching(["z", "a", "b"], ["a", "b"])).toEqual(["z"]);
  });

  it("a query with no hits is a no-op — it must not wipe the selection", () => {
    expect(toggleAllMatching(["z"], [])).toEqual(["z"]);
    expect(toggleAllMatching([], [])).toEqual([]);
  });

  it("never duplicates an id", () => {
    const out = toggleAllMatching(["a"], ["a", "b"]);
    expect(out).toEqual(["a", "b"]);
    expect(new Set(out).size).toBe(out.length);
  });
});
