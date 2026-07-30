import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAllRows, sortRowsByCreatedAt } from "./supabaseFetchAll";

// fetchAllRows paginates past PostgREST's default 1000-row cap by issuing
// successive .range() requests ordered by a stable key. These tests pin that
// loop against a mock client (.from().select().order().range() -> {data,error}).

type Row = Record<string, unknown>;

function makeClient(pageResults: Array<{ data: Row[] | null; error: unknown }>) {
  const log: Array<{ table?: string; columns?: string; eq?: [string, unknown]; eq2?: [string, unknown]; gte?: [string, unknown]; lt?: [string, unknown]; order?: [string, unknown]; range?: [number, number] }> = [];
  let current: { table?: string; columns?: string; eq?: [string, unknown]; eq2?: [string, unknown]; gte?: [string, unknown]; lt?: [string, unknown]; order?: [string, unknown]; range?: [number, number] } = {};
  const builder = {
    select(columns: string) { current.columns = columns; return builder; },
    // A second .eq() call lands in eq2 (multi-filter support) — first call keeps
    // the `eq` slot so the original assertions stay intact.
    eq(col: string, val: unknown) {
      if (current.eq) current.eq2 = [col, val];
      else current.eq = [col, val];
      return builder;
    },
    gte(col: string, val: unknown) { current.gte = [col, val]; return builder; },
    lt(col: string, val: unknown) { current.lt = [col, val]; return builder; },
    order(col: string, opts: unknown) { current.order = [col, opts]; return builder; },
    range(from: number, to: number) {
      current.range = [from, to];
      log.push(current);
      current = {};
      const idx = Math.floor(from / 1000);
      return Promise.resolve(pageResults[idx] ?? { data: [], error: null });
    },
  };
  const client = { from(table: string) { current = { table }; return builder; } };
  return { client: client as never, log };
}

const rows = (n: number, tag = "r"): Row[] => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}` }));

afterEach(() => vi.restoreAllMocks());

describe("fetchAllRows", () => {
  it("concatenates all pages until a short final page (1000 + 172 = 1172)", async () => {
    const { client, log } = makeClient([
      { data: rows(1000, "a"), error: null },
      { data: rows(172, "b"), error: null },
    ]);
    const out = await fetchAllRows(client, "campaign_numbers_v2", "id, campaign_id", "id");
    expect(out).toHaveLength(1172);
    expect(log).toHaveLength(2);
    expect(log[0].range).toEqual([0, 999]);
    expect(log[1].range).toEqual([1000, 1999]);
  });

  it("stops on an empty page after an exactly-full page", async () => {
    const { client, log } = makeClient([
      { data: rows(1000), error: null },
      { data: [], error: null },
    ]);
    const out = await fetchAllRows(client, "calls_v2", "campaign_id");
    expect(out).toHaveLength(1000);
    expect(log).toHaveLength(2);
  });

  it("issues exactly one request for a single short page", async () => {
    const { client, log } = makeClient([{ data: rows(88), error: null }]);
    const out = await fetchAllRows(client, "sms_messages_v2", "campaign_id, status");
    expect(out).toHaveLength(88);
    expect(log).toHaveLength(1);
    expect(log[0].range).toEqual([0, 999]);
  });

  it("returns rows gathered so far (loudly) if a later page errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient([
      { data: rows(1000), error: null },
      { data: null, error: { message: "boom" } },
    ]);
    const out = await fetchAllRows(client, "calls_v2", "campaign_id");
    expect(out).toHaveLength(1000);
    expect(spy).toHaveBeenCalled();
  });

  it("passes table, columns, and ascending order key through", async () => {
    const { client, log } = makeClient([{ data: rows(5), error: null }]);
    await fetchAllRows(client, "campaign_numbers_v2", "id, campaign_id, outcome", "id");
    expect(log[0].table).toBe("campaign_numbers_v2");
    expect(log[0].columns).toBe("id, campaign_id, outcome");
    expect(log[0].order).toEqual(["id", { ascending: true }]);
  });

  it("defaults the order key to id when not provided", async () => {
    const { client, log } = makeClient([{ data: rows(3), error: null }]);
    await fetchAllRows(client, "calls_v2", "campaign_id");
    expect(log[0].order).toEqual(["id", { ascending: true }]);
  });

  it("applies an optional eq filter to every page", async () => {
    const { client, log } = makeClient([
      { data: rows(1000), error: null },
      { data: rows(40), error: null },
    ]);
    const out = await fetchAllRows(client, "calls_v2", "campaign_id", "id", { column: "campaign_id", value: "camp-1" });
    expect(out).toHaveLength(1040);
    expect(log).toHaveLength(2);
    expect(log[0].eq).toEqual(["campaign_id", "camp-1"]);
    expect(log[1].eq).toEqual(["campaign_id", "camp-1"]); // filter re-applied on each paged request
  });

  it("applies an optional gte filter to every page", async () => {
    const { client, log } = makeClient([
      { data: rows(1000), error: null },
      { data: rows(13), error: null },
    ]);
    const out = await fetchAllRows(client, "calls_v2", "campaign_id", "id", undefined, {
      column: "created_at",
      value: "2026-05-18T00:00:00Z",
    });
    expect(out).toHaveLength(1013);
    expect(log[0].gte).toEqual(["created_at", "2026-05-18T00:00:00Z"]);
    expect(log[1].gte).toEqual(["created_at", "2026-05-18T00:00:00Z"]); // re-applied on each paged request
  });

  it("applies an optional lt filter to every page (day-window upper bound)", async () => {
    const { client, log } = makeClient([
      { data: rows(1000), error: null },
      { data: rows(7), error: null },
    ]);
    const out = await fetchAllRows(
      client,
      "calls_v2",
      "campaign_id",
      "id",
      undefined,
      { column: "created_at", value: "2026-07-01T00:00:00Z" },
      { column: "created_at", value: "2026-07-02T00:00:00Z" },
    );
    expect(out).toHaveLength(1007);
    expect(log[0].lt).toEqual(["created_at", "2026-07-02T00:00:00Z"]);
    expect(log[1].lt).toEqual(["created_at", "2026-07-02T00:00:00Z"]); // re-applied on each paged request
  });

  // ── VOZ truncation fix additions ──────────────────────────────────────────

  it("accepts an ARRAY of eq filters, applying each to every page (queue read: parent + status)", async () => {
    const { client, log } = makeClient([
      { data: rows(1000), error: null },
      { data: rows(20), error: null },
    ]);
    const out = await fetchAllRows(client, "realtime_seen_members", "cio_id", "cio_id", [
      { column: "parent_campaign_id", value: "parent-1" },
      { column: "status", value: "waiting" },
    ]);
    expect(out).toHaveLength(1020);
    for (const entry of log) {
      expect(entry.eq).toEqual(["parent_campaign_id", "parent-1"]);
      expect(entry.eq2).toEqual(["status", "waiting"]);
    }
  });

  it("failFast: a page error THROWS instead of degrading to partial rows (export contract)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient([
      { data: rows(1000), error: null },
      { data: null, error: { message: "boom" } },
    ]);
    await expect(
      fetchAllRows(client, "campaign_numbers_v2", "*", "id", undefined, undefined, undefined, {
        failFast: true,
      }),
    ).rejects.toThrow(/campaign_numbers_v2/);
    spy.mockRestore();
  });

  it("failFast default (absent/false) keeps the degrade-to-partial contract", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient([
      { data: rows(1000), error: null },
      { data: null, error: { message: "boom" } },
    ]);
    const out = await fetchAllRows(client, "calls_v2", "*");
    expect(out).toHaveLength(1000); // partial, loudly logged — unchanged behavior
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("sortRowsByCreatedAt", () => {
  const r = (id: string, created_at: string | null): Row => ({ id, created_at });

  it("ascending for display after a stable-id paged fetch", () => {
    const out = sortRowsByCreatedAt(
      [r("b", "2026-07-29T12:00:00Z"), r("a", "2026-07-29T11:00:00Z")],
      "asc",
    );
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("descending (calls/sms newest-first contract)", () => {
    const out = sortRowsByCreatedAt(
      [r("old", "2026-07-28T09:00:00Z"), r("new", "2026-07-30T09:00:00Z")],
      "desc",
    );
    expect(out.map((x) => x.id)).toEqual(["new", "old"]);
  });

  it("is STABLE on equal timestamps (bulk inserts share created_at — id page order must survive)", () => {
    const t = "2026-07-29T15:55:43.61085+00:00"; // the CA import: 2k rows, one timestamp
    const out = sortRowsByCreatedAt([r("r1", t), r("r2", t), r("r3", t)], "asc");
    expect(out.map((x) => x.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("sorts null/garbage created_at LAST in both directions and does not mutate its input", () => {
    const input = [r("x", null), r("a", "2026-07-29T11:00:00Z"), r("g", "not-a-date")];
    const asc = sortRowsByCreatedAt(input, "asc");
    const desc = sortRowsByCreatedAt(input, "desc");
    expect(asc.map((x) => x.id)).toEqual(["a", "x", "g"]);
    expect(desc.map((x) => x.id)).toEqual(["a", "x", "g"]);
    expect(input.map((x) => x.id)).toEqual(["x", "a", "g"]); // untouched
  });
});
