import { describe, it, expect } from "vitest";
import {
  createGhostRun,
  listGhostRuns,
  getGhostRun,
  getGhostRunBySlug,
  updateGhostRun,
} from "./ghostRunData";

// Chainable fake — records insert/update payloads + .eq() filters, and returns a
// canned terminal result. Relative imports only (vitest does not resolve "@/").
function fakeDb(opts: { rows?: unknown[] | null; single?: unknown; error?: unknown } = {}) {
  const calls = { table: null as string | null, insert: null as any, update: null as any, eqs: [] as Array<[string, unknown]>, ordered: false };
  const listResult = { data: opts.rows ?? null, error: opts.error ?? null };
  const singleResult = { data: opts.single ?? null, error: opts.error ?? null };
  const builder: any = {
    insert(p: unknown) { calls.insert = p; return builder; },
    update(p: unknown) { calls.update = p; return builder; },
    select() { return builder; },
    order() { calls.ordered = true; return Promise.resolve(listResult); },
    eq(col: string, val: unknown) { calls.eqs.push([col, val]); return builder; },
    single() { return Promise.resolve(singleResult); },
    maybeSingle() { return Promise.resolve(singleResult); },
  };
  const supabase = { from(t: string) { calls.table = t; return builder; } } as any;
  return { supabase, calls };
}

describe("createGhostRun", () => {
  it("inserts a draft run with an 8-char slug + provided fields, returns the row", async () => {
    const row = { id: "r1", slug: "abcd1234", status: "draft" };
    const { supabase, calls } = fakeDb({ single: row });
    const result = await createGhostRun(supabase, {
      name: "My Run", operator: "op@x.com", tier: "test", baseAssistantId: "base_1", uploadedCount: 12,
    });
    expect(result).toEqual(row);
    expect(calls.table).toBe("ghost_runs");
    expect(calls.insert).toMatchObject({
      name: "My Run", operator: "op@x.com", tier: "test",
      base_assistant_id: "base_1", status: "draft", uploaded_count: 12,
    });
    expect(typeof calls.insert.slug).toBe("string");
    expect(calls.insert.slug).toHaveLength(8);
  });

  it("throws when the insert errors", async () => {
    const { supabase } = fakeDb({ error: { message: "boom" } });
    await expect(
      createGhostRun(supabase, { name: "x", operator: "o", tier: "live", baseAssistantId: "b" }),
    ).rejects.toBeTruthy();
  });
});

describe("getGhostRunBySlug", () => {
  it("queries by slug and returns the row (null when absent)", async () => {
    const row = { id: "r1", slug: "abcd1234" };
    const found = fakeDb({ single: row });
    expect(await getGhostRunBySlug(found.supabase, "abcd1234")).toEqual(row);
    expect(found.calls.eqs).toContainEqual(["slug", "abcd1234"]);

    const missing = fakeDb({ single: null });
    expect(await getGhostRunBySlug(missing.supabase, "nope")).toBeNull();
  });
});

describe("getGhostRun", () => {
  it("queries by id", async () => {
    const { supabase, calls } = fakeDb({ single: { id: "r1" } });
    await getGhostRun(supabase, "r1");
    expect(calls.eqs).toContainEqual(["id", "r1"]);
  });
});

describe("updateGhostRun", () => {
  it("applies the patch by id and returns the updated row", async () => {
    const updated = { id: "r1", status: "ready", suppressed_count: 3 };
    const { supabase, calls } = fakeDb({ single: updated });
    const r = await updateGhostRun(supabase, "r1", { status: "ready", suppressed_count: 3 });
    expect(r).toEqual(updated);
    expect(calls.update).toEqual({ status: "ready", suppressed_count: 3 });
    expect(calls.eqs).toContainEqual(["id", "r1"]);
  });
});

describe("listGhostRuns", () => {
  it("returns rows ordered (empty array when none)", async () => {
    const rows = [{ id: "r1" }, { id: "r2" }];
    const { supabase, calls } = fakeDb({ rows });
    expect(await listGhostRuns(supabase)).toEqual(rows);
    expect(calls.ordered).toBe(true);

    const empty = fakeDb({ rows: null });
    expect(await listGhostRuns(empty.supabase)).toEqual([]);
  });
});
