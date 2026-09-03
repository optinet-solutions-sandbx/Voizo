import { describe, expect, it } from "vitest";
import { BRAND_WORKSPACES, DEFAULT_BRAND_WORKSPACE, brandGlyph, brandKey, brandLabel } from "./campaignDisplay";

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
  it("takes initials of two words, else first letter and first digit", () => {
    expect(brandGlyph("Fortune Play")).toBe("FP");
    expect(brandGlyph("Lucky7even")).toBe("L7");
    expect(brandGlyph("Spinsup")).toBe("SP");
    expect(brandGlyph("")).toBe("?");
  });
  it("gives every offered brand a distinct glyph", () => {
    const glyphs = BRAND_WORKSPACES.map((ws) => brandGlyph(brandLabel(ws)));
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});
