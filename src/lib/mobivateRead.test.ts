import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

function fakeFetch(pages: Array<{ status?: number; body: unknown }>) {
  const calls: string[] = [];
  let i = 0;
  const f = (async (url: string) => {
    calls.push(String(url));
    const p = pages[Math.min(i++, pages.length - 1)];
    return { ok: (p.status ?? 200) < 400, status: p.status ?? 200, text: async () => JSON.stringify(p.body) };
  }) as unknown as typeof fetch;
  return { f, calls };
}

beforeEach(() => { process.env.MOBIVATE_API_HOST = "vortex.test"; process.env.MOBIVATE_API_KEY = "k"; vi.resetModules(); });
afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; process.env = { ...ORIGINAL_ENV }; });

describe("fetchMessageHistory", () => {
  it("pages by 5000 until a short page and asserts the count against matches", async () => {
    const rec = (n: number) => ({ id: `id-${n}`, reference: n % 2 ? `ref-${n}` : null, status: "DELIVERED", price: 0.037, currency: "EUR", parts: 1, created_at: "2026-09-06T00:00:00.000Z", updated_at: "2026-09-06T00:00:05.000Z" });
    const first = Array.from({ length: 5000 }, (_, n) => rec(n));
    const second = Array.from({ length: 3 }, (_, n) => rec(5000 + n));
    const { f, calls } = fakeFetch([
      { body: { type: "SingleSMS", scanned: 5003, matches: 5003, offset: 0, limit: 5000, results: first } },
      { body: { type: "SingleSMS", scanned: 5003, matches: 5003, offset: 5000, limit: 5000, results: second } },
    ]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    const out = await fetchMessageHistory("2026-09-05", "2026-09-08", ["Lucky7even"], f);
    expect(out).toHaveLength(5003);
    expect(calls[0]).toBe("https://vortex.test/messages/history?fromDate=2026-09-05&toDate=2026-09-08&limit=5000&offset=0&originator=Lucky7even");
    expect(calls[1]).toContain("offset=5000");
    expect(out[1]).toEqual({ id: "id-1", reference: "ref-1", status: "DELIVERED", price: 0.037, currency: "EUR", parts: 1, created_at: "2026-09-06T00:00:00.000Z", updated_at: "2026-09-06T00:00:05.000Z" });
  });

  it("throws when the pages do not add up to matches (a partial pull must never look complete)", async () => {
    const { f } = fakeFetch([{ body: { type: "SingleSMS", scanned: 10, matches: 10, offset: 0, limit: 5000, results: [{ id: "a", status: "DELIVERED" }] } }]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    await expect(fetchMessageHistory("2026-09-05", "2026-09-08", ["Lucky7even"], f)).rejects.toThrow(/history\[Lucky7even\]: read 1 of 10/);
  });

  it("throws with Mobivate's own error text on a non-2xx", async () => {
    const { f } = fakeFetch([{ status: 403, body: { error: "API Key is not permitted to perform this action. (read:SingleSMS)" } }]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    await expect(fetchMessageHistory("2026-09-05", "2026-09-08", ["Lucky7even"], f)).rejects.toThrow(/403 .*read:SingleSMS/);
  });

  // VOZ-534: this is the defect that kept the job at zero successful runs. The old check was
  // `read !== expected`, and against a live feed it read 240,927 of 240,926 on 2026-09-15 — one
  // MORE than the total, because the shared account kept sending while we paged. Growth is normal;
  // only a SHORT read is truncation.
  it("does NOT throw when the feed grew under us (read > matches)", async () => {
    const rec = (n: number) => ({ id: `id-${n}`, reference: null, status: "DELIVERED", price: null, currency: null, parts: null, created_at: "x", updated_at: "y" });
    const { f } = fakeFetch([
      { body: { type: "SingleSMS", matches: 2, offset: 0, limit: 5000, results: [rec(0), rec(1), rec(2)] } },
    ]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    await expect(fetchMessageHistory("2026-09-05", "2026-09-08", ["Lucky7even"], f)).resolves.toHaveLength(3);
  });

  it("asks Mobivate once per originator, and narrows every call", async () => {
    // Unfiltered this endpoint returns the whole SHARED account: 179,583 records for a 4-day window
    // on 2026-09-16, which cannot finish inside maxDuration. Dropping the originator param is
    // therefore not a cosmetic regression, it silently reintroduces a timeout.
    const { f, calls } = fakeFetch([
      { body: { type: "SingleSMS", matches: 1, offset: 0, limit: 5000, results: [{ id: "a", reference: "r-a", status: "DELIVERED", price: null, currency: null, parts: null, created_at: "x", updated_at: "y" }] } },
    ]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    const out = await fetchMessageHistory("2026-09-05", "2026-09-08", ["Lucky7even", "FortunePlay", "RoosterBet"], f);
    expect(out).toHaveLength(3); // one record per originator from the stubbed page
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("originator=Lucky7even");
    expect(calls[1]).toContain("originator=FortunePlay");
    expect(calls[2]).toContain("originator=RoosterBet");
    expect(calls.every((c) => c.includes("originator="))).toBe(true);
  });

  it("no originators = no request at all", async () => {
    const { f, calls } = fakeFetch([{ body: { matches: 0, results: [] } }]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    expect(await fetchMessageHistory("2026-09-05", "2026-09-08", [], f)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("coerces a non-numeric price or parts to null instead of NaN", async () => {
    const { f } = fakeFetch([{ body: { matches: 1, results: [{ id: "a", reference: null, status: "DELIVERED", price: "n/a", currency: "EUR", parts: undefined, created_at: "x", updated_at: "y" }] } }]);
    const { fetchMessageHistory } = await import("./mobivateRead");
    const [r] = await fetchMessageHistory("2026-09-05", "2026-09-08", ["Lucky7even"], f);
    expect(r.price).toBeNull(); expect(r.parts).toBeNull();
  });
});

describe("fetchOptouts", () => {
  // VOZ-534: the fixture below is the REAL body, captured from /addressbook/optouts on 2026-09-16.
  // The one it replaces was invented from the docs — {success, records, total}, record keyed
  // created_on — and not one of those names exists. That is why this leg 500ed every night while
  // this file stayed green: a fixture written from documentation tests the documentation.
  // Real shape: {type, results, scanned, matches, offset, limit}, records keyed
  // {userID, msisdn, note, created_at, updated_at, id, group}.
  const realBody = (records: unknown[], matches: number) => ({
    type: "Optouts", results: records, scanned: matches, matches, offset: 0, limit: 5000,
  });

  it("pages, normalises the field names and tolerates a missing note", async () => {
    const { f } = fakeFetch([{ body: realBody([{ userID: "u1", msisdn: "64211657305", created_at: "2026-08-20T00:00:00.000Z", updated_at: "2026-08-20T00:00:00.000Z", id: "o1" }], 1) }]);
    const { fetchOptouts } = await import("./mobivateRead");
    expect(await fetchOptouts(f)).toEqual([{ msisdn: "64211657305", created_on: "2026-08-20T00:00:00.000Z", note: null, group: null }]);
  });

  // Each of these fails on exactly one of the three wrong field names, so a partial revert is caught.
  it("reads the array from `results`, never `records`", async () => {
    const { f } = fakeFetch([{ body: { type: "Optouts", records: [{ msisdn: "1" }], matches: 1, offset: 0, limit: 5000 } }]);
    const { fetchOptouts } = await import("./mobivateRead");
    await expect(fetchOptouts(f)).rejects.toThrow(/no results array/);
  });

  it("counts against `matches`, never `total` — a missing count must not skip the check silently", async () => {
    // `total` does not exist on this endpoint. Reading it left `expected` null, which SKIPS the
    // completeness assertion entirely: a truncated pull would have looked like a complete one.
    const { f } = fakeFetch([{ body: { type: "Optouts", results: [{ msisdn: "1" }], matches: 9, total: 1, offset: 0, limit: 5000 } }]);
    const { fetchOptouts } = await import("./mobivateRead");
    await expect(fetchOptouts(f)).rejects.toThrow(/read 1 of 9/);
  });

  it("does NOT throw when the list grew under us (read > matches)", async () => {
    const { f } = fakeFetch([{ body: realBody([{ msisdn: "1" }, { msisdn: "2" }], 1) }]);
    const { fetchOptouts } = await import("./mobivateRead");
    await expect(fetchOptouts(f)).resolves.toHaveLength(2);
  });
  it("throws on the 403 that means the List Opt-Outs box is not ticked", async () => {
    const { f } = fakeFetch([{ status: 403, body: { error: "API Key is not permitted to perform this action. (read:Optouts)" } }]);
    const { fetchOptouts } = await import("./mobivateRead");
    await expect(fetchOptouts(f)).rejects.toThrow(/read:Optouts/);
  });
});

describe("utcDate", () => {
  it("formats a UTC calendar day with an offset in days", async () => {
    const { utcDate } = await import("./mobivateRead");
    expect(utcDate(Date.UTC(2026, 8, 7, 23, 30), 0)).toBe("2026-09-07");
    expect(utcDate(Date.UTC(2026, 8, 7, 23, 30), 1)).toBe("2026-09-08");
    expect(utcDate(Date.UTC(2026, 8, 1, 0, 0), -3)).toBe("2026-08-29");
  });
});
