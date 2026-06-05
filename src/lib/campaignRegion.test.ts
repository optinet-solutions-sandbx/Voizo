import { describe, it, expect } from "vitest";
import { campaignRegion } from "./campaignRegion";

// Region is the 2-3 letter token in the campaign-name convention
// "L7_<REGION>_VOIZO_..." (e.g. L7_CA_, L7_AU_, L7_UAE_). Names without that
// shape (legacy "L7_VOIZO_...", ad-hoc "test ..." names) have no region.

describe("campaignRegion", () => {
  it("extracts a 2-letter region from the L7_<REGION>_ token", () => {
    expect(campaignRegion("L7_CA_VOIZO_RND_20NDFS_300%DEPMATCH_02/06/2026")).toBe("CA");
    expect(campaignRegion("L7_AU_VOIZO_RND_20NDFS_300%DEPMATCH_05/06/2026")).toBe("AU");
  });

  it("extracts a 3-letter region (e.g. UAE)", () => {
    expect(campaignRegion("L7_UAE_VOIZO_RND_X")).toBe("UAE");
  });

  it("returns null when L7_ is followed by a non-region segment (legacy names)", () => {
    expect(campaignRegion("L7_VOIZO_RND_20NDFS_300%DEPMATCH_13/05/2026")).toBeNull();
  });

  it("returns null for names without the L7_ region pattern", () => {
    expect(campaignRegion("test campaign 5/28/26")).toBeNull();
    expect(campaignRegion("test VAL agent")).toBeNull();
    expect(campaignRegion("")).toBeNull();
  });

  it("normalizes the region to uppercase", () => {
    expect(campaignRegion("l7_ca_voizo_x")).toBe("CA");
  });
});
