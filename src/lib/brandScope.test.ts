import { describe, expect, it } from "vitest";
import { BRAND_GLYPH_BG, BRAND_WORKSPACES, DEFAULT_BRAND_WORKSPACE, brandGlyph, brandKey, brandLabel } from "./campaignDisplay";

describe("brandKey", () => {
  it("normalises the routing label and reads a missing one as the default brand", () => {
    expect(brandKey("fortuneplay")).toBe("fortuneplay");
    expect(brandKey(" FortunePlay ")).toBe("fortuneplay");
    expect(brandKey(null)).toBe(DEFAULT_BRAND_WORKSPACE);
    expect(brandKey("")).toBe(DEFAULT_BRAND_WORKSPACE);
  });
  it("agrees with brandLabel on which brand a null workspace is", () => {
    expect(brandLabel(brandKey(null))).toBe(brandLabel(null));
  });
});

describe("brandGlyph", () => {
  it("takes initials of two words, else an interior capital, else a digit, else two letters", () => {
    expect(brandGlyph("Fortune Play")).toBe("FP");
    expect(brandGlyph("SpinJo")).toBe("SJ"); // interior capital wins over the second letter
    expect(brandGlyph("RoosterBet")).toBe("RB"); // …which is what keeps it apart from Rollero
    expect(brandGlyph("Rollero")).toBe("RO");
    expect(brandGlyph("Lucky7even")).toBe("L7");
    expect(brandGlyph("Spinsup")).toBe("SP");
    expect(brandGlyph("")).toBe("?");
  });
  it("gives every offered brand a distinct glyph", () => {
    const glyphs = BRAND_WORKSPACES.map((ws) => brandGlyph(brandLabel(ws)));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  // The switcher reads the name and the colour from two exports. A brand added to one and not the
  // other renders on the neutral grey, indistinguishable from the "All brands" scope-reset row.
  it("gives every offered brand its own colour", () => {
    const missing = BRAND_WORKSPACES.filter((ws) => !BRAND_GLYPH_BG[ws]);
    expect(missing).toEqual([]);
    expect(new Set(Object.values(BRAND_GLYPH_BG)).size).toBe(BRAND_WORKSPACES.length);
  });
});
