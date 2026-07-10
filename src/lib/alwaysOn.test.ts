import { describe, expect, it } from "vitest";
import { deriveAlwaysOnRows } from "./alwaysOn";

type Row = Record<string, unknown>;

const parent = (id: string, over: Row = {}): Row => ({
  id,
  name: `parent-${id}`,
  campaign_type: "recurring",
  status: "running",
  parent_campaign_id: null,
  start_at: null,
  ...over,
});
const child = (id: string, parentId: string, startAt: string, over: Row = {}): Row => ({
  id,
  name: `child-${id}`,
  campaign_type: "fixed",
  status: "running",
  parent_campaign_id: parentId,
  start_at: startAt,
  ...over,
});

describe("deriveAlwaysOnRows", () => {
  it("returns one row per running/paused recurring parent with its LATEST non-skipped child", () => {
    const rows = deriveAlwaysOnRows([
      parent("p1"),
      child("c1", "p1", "2026-07-08T13:00:00Z", { status: "completed" }),
      child("c2", "p1", "2026-07-09T13:00:00Z", { status: "paused" }),
      child("c3", "p1", "2026-07-10T13:00:00Z"),
      child("cx", "p1", "2026-07-11T13:00:00Z", { status: "skipped" }), // audit row, never dialable
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].parent.id).toBe("p1");
    expect(rows[0].latestChild?.id).toBe("c3");
  });

  it("parent with no children yet → latestChild null", () => {
    const rows = deriveAlwaysOnRows([parent("p1")]);
    expect(rows[0].latestChild).toBeNull();
  });

  it("excludes completed/archived parents and every non-recurring campaign", () => {
    const rows = deriveAlwaysOnRows([
      parent("p1", { status: "completed" }),
      parent("p2", { status: "archived" }),
      { id: "f1", name: "fixed", campaign_type: "fixed", status: "running", parent_campaign_id: null, start_at: null },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("includes paused parents (they need the Resume affordance) and sorts running first", () => {
    const rows = deriveAlwaysOnRows([
      parent("pb", { status: "paused", name: "b" }),
      parent("pa", { status: "running", name: "a" }),
      parent("pc", { status: "running", name: "c" }),
    ]);
    expect(rows.map((r) => r.parent.id)).toEqual(["pa", "pc", "pb"]);
  });

  it("children are matched to their own parent only", () => {
    const rows = deriveAlwaysOnRows([
      parent("p1"),
      parent("p2"),
      child("c1", "p1", "2026-07-10T13:00:00Z"),
    ]);
    const p2 = rows.find((r) => r.parent.id === "p2");
    expect(p2?.latestChild).toBeNull();
  });

  it("a child with a malformed/missing start_at never outranks a dated one", () => {
    const rows = deriveAlwaysOnRows([
      parent("p1"),
      child("bad", "p1", "", {}),
      child("good", "p1", "2026-07-10T13:00:00Z"),
    ]);
    expect(rows[0].latestChild?.id).toBe("good");
  });
});
