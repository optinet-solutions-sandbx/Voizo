import { describe, it, expect } from "vitest";
import { formatCampaign, campaignShortLabel, promptAgentLabel } from "./campaignDisplay";

describe("formatCampaign", () => {
  it("parses country + NDFS + DepMatch from a VOIZO code", () => {
    expect(formatCampaign("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_28/0")).toEqual({
      country: "Australia",
      offer: "20 NDFS + 300% DepMatch",
      runTag: "28/0",
      display: "Australia · 20 NDFS + 300% DepMatch · 28/0",
    });
  });

  it("handles a dated STEVIC name", () => {
    expect(formatCampaign("L7_CA_STEVIC_PROMPT_RND_20NDFS_300%DEPMATCH_11/06/2026")).toEqual({
      country: "Canada",
      offer: "20 NDFS + 300% DepMatch",
      runTag: "11/06/2026",
      display: "Canada · 20 NDFS + 300% DepMatch · 11/06/2026",
    });
  });

  it("parses spins + bonus", () => {
    const r = formatCampaign("L7_DE_VOIZO_23SPINS_300%BONUS_05/06/2026");
    expect(r.country).toBe("Germany");
    expect(r.offer).toBe("23 Spins + 300% Bonus");
  });

  it("handles GCC (3-letter region) + bare NDFS", () => {
    const r = formatCampaign("L7_GCC_VOIZO_NDFS_300%DEPMATCH_10/06/2026");
    expect(r.country).toBe("GCC");
    expect(r.offer).toBe("NDFS + 300% DepMatch");
  });

  it("falls back to a cleaned name (no L7_, no trailing date) when nothing parses", () => {
    const r = formatCampaign("L7_test_campaign_01/01/2026");
    expect(r.display).toBe("test campaign · 01/01/2026");
  });
});

describe("campaignShortLabel", () => {
  it("leads with country + run-date, dropping the shared offer", () => {
    expect(campaignShortLabel("L7_CA_STEVIC_PROMPT_RND_20NDFS_300%DEPMATCH_11/06/2026")).toBe("Canada · 11/06/2026");
    expect(campaignShortLabel("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_28/0")).toBe("Australia · 28/0");
  });

  it("two same-offer campaigns get DISTINCT short labels (the whole point)", () => {
    const a = campaignShortLabel("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_28/05/2026");
    const b = campaignShortLabel("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_01/06/2026");
    expect(a).not.toBe(b);
    expect(a).toBe("Australia · 28/05/2026");
    expect(b).toBe("Australia · 01/06/2026");
  });

  it("falls back to the full display when there's no run-date to distinguish by", () => {
    expect(campaignShortLabel("L7_CA_VOIZO_RND_20NDFS_300%DEPMATCH")).toBe("Canada · 20 NDFS + 300% DepMatch");
  });
});

describe("promptAgentLabel", () => {
  it("prepends the base-agent name when known", () => {
    expect(promptAgentLabel("Tom", "You are a friendly sales agent… · e573")).toBe(
      "Tom · You are a friendly sales agent… · e573",
    );
  });

  it("returns the snippet label alone when the name is null / blank", () => {
    expect(promptAgentLabel(null, "You are a friendly sales agent… · e573")).toBe(
      "You are a friendly sales agent… · e573",
    );
    expect(promptAgentLabel("   ", "snippet · 9f1c")).toBe("snippet · 9f1c");
  });
});
