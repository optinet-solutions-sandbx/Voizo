import { describe, it, expect } from "vitest";
import { resolveSegmentPresence } from "./segmentPresence";

describe("resolveSegmentPresence", () => {
  const segs = [
    { id: 42, name: "AU Weekly Signups" },
    { id: 7, name: "CA Daily" },
  ];

  it("resolves the name when the segment is present", () => {
    expect(resolveSegmentPresence(42, true, segs)).toEqual({ name: "AU Weekly Signups", missing: false });
  });

  it("flags missing when the list loaded but the id is absent (deleted in Customer.io)", () => {
    expect(resolveSegmentPresence(999, true, segs)).toEqual({ name: null, missing: true });
  });

  it("never flags missing when the list fetch failed (no false alarm)", () => {
    expect(resolveSegmentPresence(999, false, segs)).toEqual({ name: null, missing: false });
  });

  it("no-ops when the campaign has no segment id", () => {
    expect(resolveSegmentPresence(null, true, segs)).toEqual({ name: null, missing: false });
  });
});
