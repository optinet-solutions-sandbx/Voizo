import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchAllRows,
  fetchAllRowsParallel,
  fetchRowsIn,
  updateRowsIn,
  sortRowsByCreatedAt,
} from "./supabaseFetchAll";

// fetchAllRows paginates past PostgREST's default 1000-row cap by issuing
// successive .range() requests ordered by a stable key. These tests pin that
// loop against a mock client (.from().select().order().range() -> {data,error}).

type Row = Record<string, unknown>;

function makeClient(pageResults: Array<{ data: Row[] | null; error: unknown }>) {
  const log: Array<{ table?: string; columns?: string; eq?: [string, unknown]; eq2?: [string, unknown]; inArg?: [string, unknown]; gte?: [string, unknown]; lt?: [string, unknown]; order?: [string, unknown]; range?: [number, number] }> = [];
  let current: { table?: string; columns?: string; eq?: [string, unknown]; eq2?: [string, unknown]; inArg?: [string, unknown]; gte?: [string, unknown]; lt?: [string, unknown]; order?: [string, unknown]; range?: [number, number] } = {};
  const builder = {
    select(columns: string) { current.columns = columns; return builder; },
    in(col: string, vals: unknown) { current.inArg = [col, vals]; return builder; },
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

// ── .in() chunking (VOZ-266): the URL is the limit, not the row count ───────
//
// Measured 2026-07-30 against prod: a 1,000-phone .in() filter THROWS
// UND_ERR_HEADERS_OVERFLOW inside our own HTTP client (15.7KB of URL); 500
// passes, 2,100 draws a 400 from the edge. Chunk size 200 is the proven-margin
// precedent (theme drill-down). These tests pin the chunkers against a mock
// that records every request.

function makeChunkClient(opts?: { failChunk?: number; rowsFor?: (vals: readonly string[]) => Row[] }) {
  const reads: Array<{ table: string; columns?: string; inArgs: Array<[string, readonly string[]]>; filters: string[] }> = [];
  const updates: Array<{ table: string; patch: Row; inArgs: Array<[string, readonly string[]]>; filters: string[] }> = [];
  let readCount = 0;
  function builder(table: string) {
    const rec = { table, columns: undefined as string | undefined, patch: undefined as Row | undefined, inArgs: [] as Array<[string, readonly string[]]>, filters: [] as string[] };
    const b: Record<string, unknown> = {
      select(columns: string) { rec.columns = columns; return b; },
      update(patch: Row) { rec.patch = patch; return b; },
      eq(c: string, v: unknown) { rec.filters.push(`eq:${c}=${String(v)}`); return b; },
      neq(c: string, v: unknown) { rec.filters.push(`neq:${c}=${String(v)}`); return b; },
      gt(c: string, v: unknown) { rec.filters.push(`gt:${c}=${String(v)}`); return b; },
      in(c: string, vals: readonly string[]) { rec.inArgs.push([c, vals]); return b; },
      then(onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) {
        if (rec.patch) {
          updates.push({ table: rec.table, patch: rec.patch, inArgs: rec.inArgs, filters: rec.filters });
          const idx = updates.length - 1;
          if (opts?.failChunk === idx) return Promise.resolve({ error: { message: "update boom" }, count: null }).then(onF, onR);
          const last = rec.inArgs[rec.inArgs.length - 1];
          return Promise.resolve({ error: null, count: last ? last[1].length : 0 }).then(onF, onR);
        }
        reads.push({ table: rec.table, columns: rec.columns, inArgs: rec.inArgs, filters: rec.filters });
        const idx = readCount++;
        if (opts?.failChunk === idx) return Promise.resolve({ data: null, error: { message: "read boom" } }).then(onF, onR);
        const last = rec.inArgs[rec.inArgs.length - 1];
        const vals = last ? last[1] : [];
        const data = opts?.rowsFor ? opts.rowsFor(vals) : vals.map((v) => ({ phone_e164: v }));
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return { client: { from: builder } as never, reads, updates };
}

const vals = (n: number): string[] => Array.from({ length: n }, (_, i) => `+1999${String(i).padStart(6, "0")}`);

describe("fetchRowsIn", () => {
  it("chunks 450 values into 200/200/50 requests, re-applying extra filters on each, and concatenates", async () => {
    const { client, reads } = makeChunkClient();
    const out = await fetchRowsIn(client, "campaign_numbers_v2", "phone_e164", "phone_e164", vals(450), (q) =>
      q.eq("campaign_id", "camp-1").in("outcome", ["pending", "pending_retry"]),
    );
    expect(out).toHaveLength(450);
    expect(reads).toHaveLength(3);
    expect(reads.map((r) => r.inArgs.find(([c]) => c === "phone_e164")![1].length)).toEqual([200, 200, 50]);
    for (const r of reads) {
      expect(r.filters).toContain("eq:campaign_id=camp-1");
      expect(r.inArgs.some(([c, v]) => c === "outcome" && v.length === 2)).toBe(true);
    }
  });

  it("THROWS on any chunk error — a silently-empty safety bucket is the bug this kills", async () => {
    const { client } = makeChunkClient({ failChunk: 1 });
    await expect(fetchRowsIn(client, "suppression_list", "phone_e164", "phone_e164", vals(450))).rejects.toThrow(
      /suppression_list/,
    );
  });

  it("empty values → no requests, empty result", async () => {
    const { client, reads } = makeChunkClient();
    expect(await fetchRowsIn(client, "do_not_call", "phone_number", "phone_number", [])).toEqual([]);
    expect(reads).toHaveLength(0);
  });
});

describe("updateRowsIn", () => {
  it("chunks the update, re-applies patch + filters per chunk, and sums counts", async () => {
    const { client, updates } = makeChunkClient();
    const res = await updateRowsIn(
      client,
      "campaign_numbers_v2",
      { outcome: "removed_from_segment" },
      "phone_e164",
      vals(450),
      (q) => q.eq("campaign_id", "camp-1").in("outcome", ["pending", "pending_retry"]),
    );
    expect(res.count).toBe(450);
    expect(res.errors).toEqual([]);
    expect(updates).toHaveLength(3);
    for (const u of updates) {
      expect(u.patch).toEqual({ outcome: "removed_from_segment" });
      expect(u.filters).toContain("eq:campaign_id=camp-1");
    }
  });

  it("continues past a failed chunk, reporting it — callers own the partial-state response", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, updates } = makeChunkClient({ failChunk: 1 });
    const res = await updateRowsIn(client, "campaign_numbers_v2", { outcome: "x" }, "phone_e164", vals(450));
    expect(updates).toHaveLength(3); // chunk 2 failed, chunk 3 still attempted
    expect(res.count).toBe(250); // 200 + 50, the failed 200 not counted
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/update boom/);
    spy.mockRestore();
  });
});

describe("fetchAllRows opts.inFilter (the outcome IN (pending,pending_retry) family)", () => {
  it("applies the in-filter to every page", async () => {
    const { client, log } = makeClient([
      { data: rows(1000), error: null },
      { data: rows(40), error: null },
    ]);
    const out = await fetchAllRows(client, "campaign_numbers_v2", "phone_e164", "id", { column: "campaign_id", value: "c1" }, undefined, undefined, {
      inFilter: { column: "outcome", values: ["pending", "pending_retry"] },
    });
    expect(out).toHaveLength(1040);
    expect(log).toHaveLength(2);
    for (const entry of log) expect(entry.inArg).toEqual(["outcome", ["pending", "pending_retry"]]);
  });
});

// ── fetchAllRowsParallel ─────────────────────────────────────────────────────
// Count-then-concurrent-pages. The mock answers the head:true count call from
// `total`, then serves each .range() by page index (like makeClient), with
// optional scripted failures: failAt[page] = number of times that page errors
// before succeeding (Infinity = always fails).

function makeParallelClient(total: number, pageData: (page: number) => Row[], failAt: Record<number, number> = {}, countError: { message: string } | null = null) {
  const rangeCalls: number[] = [];
  const gteCalls: Array<[string, unknown]> = [];
  const failsLeft: Record<number, number> = { ...failAt };
  const builder = (table: string) => {
    let isCount = false;
    const b = {
      select(_cols: string, opts?: { count?: string; head?: boolean }) {
        isCount = opts?.head === true;
        return b;
      },
      gte(col: string, val: unknown) { gteCalls.push([col, val]); return b; },
      order() { return b; },
      range(from: number) {
        const page = Math.floor(from / 1000);
        rangeCalls.push(page);
        if ((failsLeft[page] ?? 0) > 0) {
          failsLeft[page]!--;
          return Promise.resolve({ data: null, error: { message: `page ${page} boom` } });
        }
        return Promise.resolve({ data: pageData(page), error: null });
      },
      // The count call is awaited directly on the builder (no .range()).
      then(resolve: (v: unknown) => void) {
        if (isCount) resolve(countError ? { count: null, error: countError } : { count: total, error: null });
      },
    };
    void table;
    return b;
  };
  return { client: { from: builder } as never, rangeCalls, gteCalls };
}

describe("fetchAllRowsParallel", () => {
  it("counts, fires all pages, and preserves page order (2172 rows = 3 pages)", async () => {
    const { client, rangeCalls } = makeParallelClient(2172, (p) =>
      rows(p === 2 ? 172 : 1000, `p${p}-`),
    );
    const out = await fetchAllRowsParallel(client, "calls_v2", "id, campaign_id");
    expect(out).toHaveLength(2172);
    // Order preserved regardless of completion order: page 0 rows first, page 2 last.
    expect(out[0].id).toBe("p0-0");
    expect(out[1000].id).toBe("p1-0");
    expect(out[2171].id).toBe("p2-171");
    expect(new Set(rangeCalls)).toEqual(new Set([0, 1, 2]));
  });

  it("retries a failed page once and succeeds", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeParallelClient(1500, (p) => rows(p === 1 ? 500 : 1000, `p${p}-`), { 1: 1 });
    const out = await fetchAllRowsParallel(client, "calls_v2", "id");
    expect(out).toHaveLength(1500);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("throws (never a gappy partial) when a page fails twice", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeParallelClient(1500, (p) => rows(p === 1 ? 500 : 1000), { 1: Infinity });
    await expect(fetchAllRowsParallel(client, "calls_v2", "id")).rejects.toThrow(/page 1 failed twice/);
    spy.mockRestore();
  });

  it("throws on a count error", async () => {
    const { client } = makeParallelClient(0, () => [], {}, { message: "count boom" });
    await expect(fetchAllRowsParallel(client, "calls_v2", "id")).rejects.toThrow(/count failed: count boom/);
  });

  it("returns [] for an empty table without firing page reads", async () => {
    const { client, rangeCalls } = makeParallelClient(0, () => rows(1000));
    expect(await fetchAllRowsParallel(client, "calls_v2", "id")).toEqual([]);
    expect(rangeCalls).toHaveLength(0);
  });

  it("applies gte to BOTH the count call and every page", async () => {
    const { client, gteCalls } = makeParallelClient(1500, (p) => rows(p === 1 ? 500 : 1000));
    const out = await fetchAllRowsParallel(client, "calls_v2", "id", "id", {
      column: "created_at",
      value: "2026-07-06T00:00:00Z",
    });
    expect(out).toHaveLength(1500);
    // 1 count + 2 pages = 3 gte applications, all identical.
    expect(gteCalls).toHaveLength(3);
    for (const g of gteCalls) expect(g).toEqual(["created_at", "2026-07-06T00:00:00Z"]);
  });

  it("extends past the count when the last page is exactly full (insert-during-read tail)", async () => {
    // count said 1000 (1 page) but 1050 rows exist by read time.
    const { client } = makeParallelClient(1000, (p) => (p === 0 ? rows(1000, "a") : p === 1 ? rows(50, "b") : []));
    const out = await fetchAllRowsParallel(client, "calls_v2", "id");
    expect(out).toHaveLength(1050);
    expect(out[1049].id).toBe("b49");
  });
});
