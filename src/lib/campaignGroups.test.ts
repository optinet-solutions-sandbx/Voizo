import { describe, it, expect } from "vitest";
import { groupCampaignOptions, visibleChildren, CHILD_PAGE_SIZE, type GroupableOption } from "./campaignGroups";

const opt = (value: string, over: Partial<GroupableOption> = {}): GroupableOption => ({
  value,
  label: `Australia · REACTIVATION (${value})`,
  search: `Australia · REACTIVATION (${value})`,
  parentId: "p-au-l7",
  runLabel: value,
  ...over,
});

const PARENTS = { "p-au-l7": "Australia · REACTIVATION · Lucky7even", "p-au-fp": "Australia · REACTIVATION · Fortune Play" };

describe("groupCampaignOptions", () => {
  it("collapses children under their parent, newest run first", () => {
    const { groups, loose } = groupCampaignOptions(
      [opt("2026-08-24"), opt("2026-08-26"), opt("2026-08-25")],
      PARENTS,
    );
    expect(loose).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Australia · REACTIVATION · Lucky7even");
    expect(groups[0].options.map((o) => o.runLabel)).toEqual(["2026-08-26", "2026-08-25", "2026-08-24"]);
  });

  it("keeps two same-named parents apart by their own labels", () => {
    const { groups } = groupCampaignOptions(
      [opt("2026-08-26"), opt("2026-08-26b", { parentId: "p-au-fp" })],
      PARENTS,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Australia · REACTIVATION · Fortune Play",
      "Australia · REACTIVATION · Lucky7even",
    ]);
  });

  it("a campaign with no parent stays loose — it is not invented a group", () => {
    const { groups, loose } = groupCampaignOptions(
      [opt("2026-08-26"), opt("one-off", { parentId: null, label: "Australia · 20 NDFS · 05/06/2026" })],
      PARENTS,
    );
    expect(groups).toHaveLength(1);
    expect(loose.map((o) => o.value)).toEqual(["one-off"]);
  });

  it("THE TRAP: an UNKNOWN parent id must fall loose, never vanish", () => {
    // The parent row is out of the window / not in the payload. Dropping the child would
    // silently hide a campaign that the KPIs are still counting.
    const { groups, loose } = groupCampaignOptions([opt("2026-08-26", { parentId: "p-ghost" })], PARENTS);
    expect(groups).toEqual([]);
    expect(loose.map((o) => o.value)).toEqual(["2026-08-26"]);
  });

  it("every input option comes out exactly once, grouped or loose", () => {
    const input = [
      opt("2026-08-26"),
      opt("2026-08-25"),
      opt("fp-1", { parentId: "p-au-fp" }),
      opt("orphan", { parentId: null }),
      opt("ghost", { parentId: "p-nope" }),
    ];
    const { groups, loose } = groupCampaignOptions(input, PARENTS);
    const out = [...groups.flatMap((g) => g.options), ...loose].map((o) => o.value).sort();
    expect(out).toEqual(input.map((o) => o.value).sort());
  });

  it("groups sort by label, so the list does not reshuffle between renders", () => {
    const parents = { z: "Zed", a: "Alpha", m: "Mid" };
    const { groups } = groupCampaignOptions(
      [opt("1", { parentId: "z" }), opt("2", { parentId: "a" }), opt("3", { parentId: "m" })],
      parents,
    );
    expect(groups.map((g) => g.label)).toEqual(["Alpha", "Mid", "Zed"]);
  });

  it("carries the child ids for a whole-group toggle", () => {
    const { groups } = groupCampaignOptions([opt("2026-08-26"), opt("2026-08-25")], PARENTS);
    expect(groups[0].options.map((o) => o.value)).toEqual(["2026-08-26", "2026-08-25"]);
    expect(groups[0].key).toBe("p-au-l7");
  });

  it("handles an empty option list without inventing rows", () => {
    expect(groupCampaignOptions([], PARENTS)).toEqual({ groups: [], loose: [] });
  });
});

describe("visibleChildren — a group opens capped (2026-09-01)", () => {
  const runs = Array.from({ length: 36 }, (_, i) => `run-${i}`);

  it("shows the first CHILD_PAGE_SIZE and counts the rest", () => {
    const { shown, hidden } = visibleChildren(runs, false);
    expect(shown).toHaveLength(CHILD_PAGE_SIZE);
    expect(shown[0]).toBe("run-0");
    expect(hidden).toBe(36 - CHILD_PAGE_SIZE);
  });

  it("shows everything once asked, and hides nothing", () => {
    const { shown, hidden } = visibleChildren(runs, true);
    expect(shown).toHaveLength(36);
    expect(hidden).toBe(0);
  });

  it("a group at or under the cap never offers show-all", () => {
    expect(visibleChildren(runs.slice(0, CHILD_PAGE_SIZE), false).hidden).toBe(0);
    expect(visibleChildren([], false)).toEqual({ shown: [], hidden: 0 });
  });
});
