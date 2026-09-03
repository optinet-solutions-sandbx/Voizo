import { describe, expect, it } from "vitest";
import { groupCampaignRows, sortGroups, runOrdinals, playOf, type GroupableRow, type GroupLabels } from "./campaignGrouping";

const L: GroupLabels = {
  family: (pid) => ({ "p-fp-au": "Australia · Daily Conversion · Fortune Play", "p-l7-au": "Australia · Daily Conversion · Lucky7even" }[pid] ?? null),
  brand: (ws) => (ws === "fortuneplay" ? "Fortune Play" : "Lucky7even"),
  agent: (r) => r.baseAssistantId ?? "Unknown agent",
  fallbackName: (r) => r.name,
};

const run = (id: string, o: Partial<GroupableRow> = {}): GroupableRow => ({
  id, name: `run ${id}`, country: "Australia", cioWorkspace: "fortuneplay", baseAssistantId: "val", voiceId: null,
  scriptId: "s1", scriptName: "Daily", parentCampaignId: "p-fp-au", displayStatus: "finished", startAt: "2026-08-20T00:00:00Z",
  attempts: 100, conversations: 10, sms: 5, ...o,
});

describe("groupCampaignRows — runs fold under what they belong to", () => {
  const rows = [
    run("a"), run("b", { startAt: "2026-08-21T00:00:00Z", displayStatus: "running" }),
    run("c", { parentCampaignId: "p-l7-au", cioWorkspace: "lucky7even", attempts: 7 }),
    run("solo", { parentCampaignId: null, name: "One-off test" }),
  ];

  it("family = the recurring parent, labelled the way the picker labels it; a one-off is a family of one", () => {
    const g = groupCampaignRows(rows, "family", L);
    expect(g.map((x) => x.label)).toEqual([
      "Australia · Daily Conversion · Fortune Play",
      "Australia · Daily Conversion · Lucky7even",
      "One-off test",
    ]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(g[2].single).toBe(true);
  });

  it("sums the three metrics and takes the liveliest status", () => {
    const g = groupCampaignRows(rows, "family", L)[0];
    expect(g.attempts).toBe(200);
    expect(g.conversations).toBe(20);
    expect(g.sms).toBe(10);
    expect(g.status).toBe("running"); // a is finished, b is running
    expect(g.single).toBe(false);
  });

  it("a parent the labels do not know falls back to the run's own name, never blank", () => {
    const g = groupCampaignRows([run("x", { parentCampaignId: "p-unknown", name: "Mystery run" })], "family", L);
    expect(g[0].label).toBe("Mystery run");
  });

  it("brand grouping merges families and lists distinct brands", () => {
    const g = groupCampaignRows(rows, "brand", L);
    expect(g.map((x) => [x.label, x.rows.length])).toEqual([["Fortune Play", 3], ["Lucky7even", 1]]);
  });

  it("country grouping puts every AU run together, brands recorded for the header chips", () => {
    const g = groupCampaignRows(rows, "country", L);
    expect(g).toHaveLength(1);
    expect(g[0].brands.sort()).toEqual(["fortuneplay", "lucky7even"]);
  });

  it("none = one group per run, every one single, so the table reads flat", () => {
    const g = groupCampaignRows(rows, "none", L);
    expect(g).toHaveLength(4);
    expect(g.every((x) => x.single)).toBe(true);
  });

  it("an empty table groups to nothing", () => {
    expect(groupCampaignRows([], "family", L)).toEqual([]);
  });
});

describe("sortGroups — groups follow the sort the rows are under", () => {
  const small = { key: "s", label: "s", rows: [run("s", { startAt: "2026-08-25T00:00:00Z" })], single: true, attempts: 10, conversations: 9, sms: 1, status: "finished" as const, brands: [] };
  const big = { key: "b", label: "b", rows: [run("b1", { startAt: "2026-08-01T00:00:00Z" }), run("b2", { startAt: "2026-08-10T00:00:00Z" })], single: false, attempts: 500, conversations: 2, sms: 40, status: "finished" as const, brands: [] };

  it("by attempts: the bigger sum first", () => {
    expect(sortGroups([small, big], "calls").map((g) => g.key)).toEqual(["b", "s"]);
  });
  it("by conversations: the bigger sum first, even when attempts say otherwise", () => {
    expect(sortGroups([big, small], "reached").map((g) => g.key)).toEqual(["s", "b"]);
  });
  it("newest: the group holding the most recent run first", () => {
    expect(sortGroups([big, small], "newest").map((g) => g.key)).toEqual(["s", "b"]);
  });
  it("does not mutate its input", () => {
    const input = [small, big];
    sortGroups(input, "calls");
    expect(input.map((g) => g.key)).toEqual(["s", "b"]);
  });
});

describe("a null brand is the default brand, never 'Default' (found live 2026-09-03)", () => {
  it("brand chips on a mixed header name the default workspace, and group the null rows with it", () => {
    const rows = [run("a", { cioWorkspace: null }), run("b", { cioWorkspace: "lucky7even" }), run("c", { cioWorkspace: "fortuneplay" })];
    const byBrand = groupCampaignRows(rows, "brand", L);
    expect(byBrand.map((g) => [g.label, g.rows.length]).sort()).toEqual([["Fortune Play", 1], ["Lucky7even", 2]]);
    const one = groupCampaignRows(rows, "country", L)[0];
    expect(one.brands.sort()).toEqual(["fortuneplay", "lucky7even"]);
    expect(one.brands).not.toContain("default");
  });
});

describe("runOrdinals — a family that ran twice in one day numbers its runs (2026-09-01 rule)", () => {
  const twin = (id: string, startAt: string, o: Partial<GroupableRow> = {}) => run(id, { startAt, ...o });

  it("two runs of one family on one day read 'run 1 of 2' and 'run 2 of 2', in start order", () => {
    const rows = [twin("late", "2026-08-19T14:00:00Z"), twin("early", "2026-08-19T09:00:00Z"), twin("other", "2026-08-20T09:00:00Z")];
    const n = runOrdinals(rows);
    expect(n.get("early")).toBe("run 1 of 2");
    expect(n.get("late")).toBe("run 2 of 2");
    expect(n.get("other")).toBe("");
  });

  it("a lone run is never numbered — 'run 1 of 1' would be noise", () => {
    expect(runOrdinals([twin("a", "2026-08-19T09:00:00Z")]).get("a")).toBe("");
  });

  it("same day, different brand or country or family: not twins", () => {
    const rows = [
      twin("a", "2026-08-19T09:00:00Z"),
      twin("b", "2026-08-19T10:00:00Z", { cioWorkspace: "lucky7even" }),
      twin("c", "2026-08-19T11:00:00Z", { country: "New Zealand" }),
      twin("d", "2026-08-19T12:00:00Z", { parentCampaignId: "p-other" }),
    ];
    const n = runOrdinals(rows);
    expect([...n.values()].every((v) => v === "")).toBe(true);
  });

  it("the day is the UTC day of startAt; a run with no startAt is never numbered", () => {
    const rows = [twin("a", "2026-08-19T23:30:00Z"), twin("b", "2026-08-20T00:30:00Z"), run("x", { startAt: null }), run("y", { startAt: null })];
    const n = runOrdinals(rows);
    expect(n.get("a")).toBe("");
    expect(n.get("b")).toBe("");
    expect(n.get("x")).toBe("");
    expect(n.get("y")).toBe("");
  });

  it("three in a day count to three", () => {
    const rows = ["a", "b", "c"].map((id, i) => twin(id, `2026-08-19T0${i + 1}:00:00Z`));
    expect([...runOrdinals(rows).values()]).toEqual(["run 1 of 3", "run 2 of 3", "run 3 of 3"]);
  });
});

describe("playOf — the family's play, same across brands and markets", () => {
  it("drops the country in front and the brand behind", () => {
    expect(playOf("Australia · REACTIVATION · Fortune Play", "Australia", "Fortune Play")).toBe("REACTIVATION");
    expect(playOf("Australia · REACTIVATION · Lucky7even", "Australia", "Lucky7even")).toBe("REACTIVATION");
    expect(playOf("New Zealand · RND REG YESTERDAY · Fortune Play", "New Zealand", "Fortune Play")).toBe("RND REG YESTERDAY");
  });
  it("keeps a label that has no country or brand to drop", () => {
    expect(playOf("STEVIC", "Australia", "Fortune Play")).toBe("STEVIC");
  });
  it("never empties a one-segment label, and never drops a segment that only looks like the brand", () => {
    expect(playOf("Fortune Play", "Australia", "Fortune Play")).toBe("Fortune Play");
    expect(playOf("Australia · Fortune Play Reactivation · Fortune Play", "Australia", "Fortune Play")).toBe("Fortune Play Reactivation");
  });
});
