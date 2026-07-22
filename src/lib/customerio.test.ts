import { describe, expect, it } from "vitest";
import { lookupLadder } from "./customerio";

// VOZ-185: identifier forms empirically verified against the live EU App API
// (2026-07-22): the legacy `cio_<cio_id>` prefix form and raw-email form 404;
// bare cio_id and email resolve only with an explicit id_type. Leg 1
// (workspace id, no id_type) is untouched — prod-proven for months.
describe("lookupLadder (VOZ-185 identifier fallback)", () => {
  const member = { id: "lucky7even:158491", cio_id: "a2f707098dcf01be8c12", email: "p@x.com" };

  it("full member → id (no id_type), then BARE cio_id + id_type, then email + id_type", () => {
    expect(lookupLadder(member)).toEqual([
      { identifier: "lucky7even:158491" },
      { identifier: "a2f707098dcf01be8c12", idType: "cio_id" },
      { identifier: "p@x.com", idType: "email" },
    ]);
  });

  it("id-less member (the 07-22 trial profile shape) → cio_id leg leads, NO cio_ prefix", () => {
    const ladder = lookupLadder({ cio_id: "a2f707098dcf01be8c12", email: "p@x.com" });
    expect(ladder).toEqual([
      { identifier: "a2f707098dcf01be8c12", idType: "cio_id" },
      { identifier: "p@x.com", idType: "email" },
    ]);
    // The regression that made legs 2/3 dead: the prefix form must never return.
    expect(ladder.some((l) => l.identifier.startsWith("cio_"))).toBe(false);
  });

  it("blank/whitespace identifiers are filtered", () => {
    expect(lookupLadder({ id: "  ", cio_id: "", email: "p@x.com" })).toEqual([
      { identifier: "p@x.com", idType: "email" },
    ]);
  });

  it("member with no usable identifiers → empty ladder (caller reports failure)", () => {
    expect(lookupLadder({ cio_id: "" })).toEqual([]);
  });
});
