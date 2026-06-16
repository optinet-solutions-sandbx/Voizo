import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchAllRows } from "./supabaseFetchAll";

// fetchAllRows paginates past PostgREST's default 1000-row cap by issuing
// successive .range() requests ordered by a stable key. These tests pin that
// loop against a mock client (.from().select().order().range() -> {data,error}).

type Row = Record<string, unknown>;

function makeClient(pageResults: Array<{ data: Row[] | null; error: unknown }>) {
  const log: Array<{ table?: string; columns?: string; eq?: [string, unknown]; order?: [string, unknown]; range?: [number, number] }> = [];
  let current: { table?: string; columns?: string; eq?: [string, unknown]; order?: [string, unknown]; range?: [number, number] } = {};
  const builder = {
    select(columns: string) { current.columns = columns; return builder; },
    eq(col: string, val: unknown) { current.eq = [col, val]; return builder; },
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
});
