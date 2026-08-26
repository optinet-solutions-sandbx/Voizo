import { describe, it, expect } from "vitest";
import {
  formatCampaign,
  campaignShortLabel,
  campaignFilterLabels,
  campaignRunLabel,
  campaignGroupHeaderLabels,
  promptAgentLabel,
  campaignIdsForCountry,
  brandLabel,
  distinctBrandLabels,
  DEFAULT_BRAND_WORKSPACE,
} from "./campaignDisplay";
import { CIO_DEFAULT_WORKSPACE } from "./customerio";

describe("brandLabel (VOZ-216 — which brand is this campaign?)", () => {
  it("the client-side default brand CANNOT drift from the server's routing default", () => {
    // A mismatch would label every legacy (NULL cio_workspace) campaign as the
    // wrong brand on the dashboard while routing kept using the real default.
    expect(DEFAULT_BRAND_WORKSPACE).toBe(CIO_DEFAULT_WORKSPACE);
  });

  it("maps the configured brands to their operator-facing names", () => {
    expect(brandLabel("lucky7even")).toBe("Lucky7even");
    expect(brandLabel("fortuneplay")).toBe("Fortune Play");
  });

  it("treats NULL/blank as the default brand (pre-VOZ-198 rows)", () => {
    expect(brandLabel(null)).toBe("Lucky7even");
    expect(brandLabel(undefined)).toBe("Lucky7even");
    expect(brandLabel("   ")).toBe("Lucky7even");
  });

  it("renders an unmapped future brand instead of going blank", () => {
    expect(brandLabel("roosterbet")).toBe("Roosterbet");
    expect(brandLabel(" FortunePlay ")).toBe("Fortune Play"); // trimmed + case-insensitive lookup
  });
});

describe("distinctBrandLabels (aggregate-panel brand scope)", () => {
  it("dedupes, folds NULL into the default, and sorts alphabetically", () => {
    expect(distinctBrandLabels(["fortuneplay", "lucky7even", null, "lucky7even"])).toEqual([
      "Fortune Play",
      "Lucky7even",
    ]);
  });

  it("no campaigns → no brands (panel shows nothing, not a phantom default)", () => {
    expect(distinctBrandLabels([])).toEqual([]);
  });
});

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

describe("campaignIdsForCountry", () => {
  const campaigns = [
    { id: "au1", name: "L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_28/05/2026" },
    { id: "au2", name: "L7_AU_STEVIC_PROMPT_RND_20NDFS_01/07/2026" },
    { id: "ca1", name: "L7_CA_STEVIC_PROMPT_RND_20NDFS_300%DEPMATCH_11/06/2026" },
    { id: "test1", name: "Agent response test - EVA" }, // no parseable country
  ];

  it("returns exactly the campaign ids whose parsed country matches", () => {
    expect(campaignIdsForCountry(campaigns, "Australia")).toEqual(new Set(["au1", "au2"]));
    expect(campaignIdsForCountry(campaigns, "Canada")).toEqual(new Set(["ca1"]));
  });

  it("excludes campaigns with no parseable country", () => {
    const all = new Set([...campaignIdsForCountry(campaigns, "Australia"), ...campaignIdsForCountry(campaigns, "Canada")]);
    expect(all.has("test1")).toBe(false);
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

// The pipe-delimited family (2026-08 naming: "Daily Automated Conversion | VOIZO
// <THING> <CC> [| Brand]"). formatCampaign only PREPENDS the country to these and
// keeps the whole raw name, so the filter dropdown read "Daily Automated Conversi…"
// on every row (Val's CRM team, 2026-08-26).
describe("campaignShortLabel — pipe-delimited names", () => {
  it("drops the boilerplate segment and the VOIZO / Campaign noise", () => {
    expect(campaignShortLabel("Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU"))
      .toBe("Australia · REACTIVATION");
    expect(campaignShortLabel("Daily Automated Conversion | VOIZO REACTIVATION Campaign - CA"))
      .toBe("Canada · REACTIVATION");
    expect(campaignShortLabel("Daily Automated Conversion | VOIZO RND REG YESTERDAY AU"))
      .toBe("Australia · RND REG YESTERDAY");
  });

  it("reads the same however the segments are ordered", () => {
    expect(campaignShortLabel("VOIZO REACTIVATION - NZ | Daily Automated"))
      .toBe("New Zealand · REACTIVATION");
    expect(campaignShortLabel("VOIZO RND REG YESTERDAY NZ | Daily Automated Conversion"))
      .toBe("New Zealand · RND REG YESTERDAY");
  });

  it("THE POINT: a trailing brand segment survives, so the two AU runs stay distinct", () => {
    const plain = campaignShortLabel("Daily Automated Conversion | VOIZO RND REG YESTERDAY AU");
    const branded = campaignShortLabel("Daily Automated Conversion | VOIZO RND REG YESTERDAY AU | Fortune Play");
    expect(branded).toBe("Australia · RND REG YESTERDAY · Fortune Play");
    expect(plain).not.toBe(branded);
  });

  it("keeps the naming part in front of a long brand + date segment", () => {
    // The distinctive part is the SHORTER segment here, so "longest wins" reads backwards.
    expect(campaignShortLabel("Daily Automated Conversion | VOIZO RND REG YESTERDAY AU | Fortune Play (2026-08-25)"))
      .toBe("Australia · RND REG YESTERDAY · Fortune Play (2026-08-25)");
  });

  it("leaves the L7_ family exactly as it was", () => {
    expect(campaignShortLabel("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_05/06/2026")).toBe("Australia · 05/06/2026");
  });

  it("falls back to the full display rather than rendering an empty label", () => {
    // Every segment is boilerplate — there is no distinctive part to lead with.
    expect(campaignShortLabel("Daily Automated | Daily Automated Conversion"))
      .toBe(formatCampaign("Daily Automated | Daily Automated Conversion").display);
    expect(campaignShortLabel("|")).toBe(formatCampaign("|").display);
    expect(campaignShortLabel(null)).toBe(formatCampaign(null).display);
  });
});

// The campaigns FILTER labels (dropdown options + active chips). Verified 2026-08-26 against
// the real 234-campaign lifetime payload: 233 of 234 render distinctly.
describe("campaignFilterLabels", () => {
  const camp = (id: string, name: string, brand: string | null, startAt: string | null) => ({ id, name, brand, startAt });
  const AU = "Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU (2026-08-20)";

  it("adds nothing when the short label is already unique", () => {
    const m = campaignFilterLabels([
      camp("1", AU, "lucky7even", "2026-08-20T01:00:00+00:00"),
      camp("2", "Daily Automated Conversion | VOIZO RND REG YESTERDAY AU (2026-08-20)", "fortuneplay", "2026-08-20T01:00:00+00:00"),
    ]);
    expect(m.get("1")).toBe("Australia · REACTIVATION (2026-08-20)");
    expect(m.get("2")).toBe("Australia · RND REG YESTERDAY (2026-08-20)");
  });

  it("THE POINT: the same campaign run for two brands separates on BRAND, not the date", () => {
    // Measured: these pairs share the name AND start the same minute, so a date cannot split them.
    const m = campaignFilterLabels([
      camp("1", AU, "lucky7even", "2026-08-20T01:00:00+00:00"),
      camp("2", AU, "fortuneplay", "2026-08-20T01:00:00+00:00"),
    ]);
    expect(m.get("1")).toBe("Australia · REACTIVATION (2026-08-20) · Lucky7even");
    expect(m.get("2")).toBe("Australia · REACTIVATION (2026-08-20) · Fortune Play");
  });

  it("falls back to the start date when the brand is shared too", () => {
    // A name carrying no run date of its own, run twice — the date is what's left.
    const m = campaignFilterLabels([
      camp("1", "Agent response test - EVA", "lucky7even", "2026-05-13T12:00:00+00:00"),
      camp("2", "Agent response test - EVA", "lucky7even", "2026-05-20T12:00:00+00:00"),
    ]);
    expect(m.get("1")).not.toBe(m.get("2"));
    expect(m.get("1")).toContain("Lucky7even");
  });

  it("a genuine twin (same name, brand AND day) still reads the same — as it always did", () => {
    const m = campaignFilterLabels([
      camp("1", "Agent response test - EVA", "lucky7even", "2026-05-13T09:23:12+00:00"),
      camp("2", "Agent response test - EVA", "lucky7even", "2026-05-13T09:27:26+00:00"),
    ]);
    expect(m.get("1")).toBe(m.get("2"));
  });

  it("survives a missing brand and a missing start date", () => {
    const m = campaignFilterLabels([camp("1", AU, null, null)]);
    expect(m.get("1")).toBe("Australia · REACTIVATION (2026-08-20)");
  });
});

// Inside a parent group the header already carries country/name/brand, so a child row only has
// to say WHICH RUN it is (2026-08-26). Grouped dropdown, 2026-08-26.
describe("campaignRunLabel", () => {
  it("reads the run date stamped in the name", () => {
    expect(campaignRunLabel("Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU (2026-08-20)", null))
      .toBe("2026-08-20");
    expect(campaignRunLabel("VOIZO REACTIVATION - NZ | Daily Automated (2026-08-26)", null)).toBe("2026-08-26");
  });

  it("falls back to the L7_ run tag", () => {
    expect(campaignRunLabel("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_05/06/2026", null)).toBe("05/06/2026");
  });

  it("falls back to the start date when the name carries neither", () => {
    // Mid-day UTC so the day cannot slip across a timezone.
    expect(campaignRunLabel("Agent response test - EVA", "2026-05-13T12:00:00+00:00")).toContain("May");
  });

  it("returns \"\" rather than a misleading date when there is nothing to show", () => {
    expect(campaignRunLabel("Agent response test - EVA", null)).toBe("");
    expect(campaignRunLabel(null, null)).toBe("");
  });
});

// A GROUP HEADER has to describe itself — an operator reading one of ten collapsed rows has no
// sibling to compare it against. campaignFilterLabels only names the brand when labels COLLIDE,
// and the Fortune Play parents carry "Fortune Play" in their own names, so no collision fires
// and the Lucky7even sibling was left anonymous. Verified on the live page, 2026-08-26.
describe("campaignGroupHeaderLabels", () => {
  const p = (id: string, name: string, brand: string | null) => ({ id, name, brand, startAt: null });
  const L7 = "Daily Automated Conversion | VOIZO RND REG YESTERDAY AU";
  const FP = "Daily Automated Conversion | VOIZO RND REG YESTERDAY AU | Fortune Play";

  it("THE POINT: both siblings name their brand, and neither says it twice", () => {
    const m = campaignGroupHeaderLabels([p("1", L7, "lucky7even"), p("2", FP, "fortuneplay")]);
    expect(m.get("1")).toBe("Australia · RND REG YESTERDAY · Lucky7even");
    expect(m.get("2")).toBe("Australia · RND REG YESTERDAY · Fortune Play");
  });

  it("adds no brand at all when only one brand is in scope — that would be noise", () => {
    const m = campaignGroupHeaderLabels([p("1", L7, "lucky7even")]);
    expect(m.get("1")).toBe("Australia · RND REG YESTERDAY");
  });

  it("still disambiguates two parents that share a name AND a brand", () => {
    const m = campaignGroupHeaderLabels([
      { id: "1", name: L7, brand: "lucky7even", startAt: "2026-05-13T12:00:00+00:00" },
      { id: "2", name: L7, brand: "lucky7even", startAt: "2026-05-20T12:00:00+00:00" },
      p("3", FP, "fortuneplay"),
    ]);
    expect(m.get("1")).not.toBe(m.get("2"));
  });
});
