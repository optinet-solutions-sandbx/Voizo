import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Fake supabase ──────────────────────────────────────────────────────────
// dialer.ts imports the service-role singleton from ./supabaseServer, which THROWS
// at module load when env is unset — that is why this file mocks the module rather
// than setting env (same approach as the ghost route tests). Its other imports are
// safe to load: freeswitch/originate pulls only `crypto`, freeswitch/callerId reads
// env at CALL time, and scheduleWindow is pure.
//
// vi.mock factories are hoisted ABOVE the imports, so the scriptable state has to be
// created with vi.hoisted() or the factory would hit a TDZ error on `h`.
const h = vi.hoisted(() => ({
  /** Queue of scripted responses; each awaited query shifts one off. */
  responses: [] as Array<{ count?: number | null; error?: { message: string } | null }>,
  /** Table names touched, in order — lets us assert short-circuiting. */
  queries: [] as string[],
}));

vi.mock("./supabaseServer", () => {
  const CHAIN = ["select", "eq", "gt", "lt", "gte", "lte", "in", "is", "not", "or", "order", "limit"];
  function builder(table: string) {
    h.queries.push(table);
    const chain: Record<string, unknown> = {
      // Thenable: awaiting the builder resolves the next scripted response.
      then(resolve: (v: unknown) => void) {
        const next = h.responses.shift() ?? { count: 0, error: null };
        resolve({ data: null, count: next.count ?? null, error: next.error ?? null });
      },
    };
    for (const m of CHAIN) chain[m] = () => chain;
    return chain;
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});

import { hasPendingRetry } from "./dialer";

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.responses.length = 0;
  h.queries.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

describe("hasPendingRetry", () => {
  it("true when pending_retry rows are queued — and short-circuits before the 2nd query", async () => {
    h.responses.push({ count: 3 });
    await expect(hasPendingRetry("c1")).resolves.toBe(true);
    expect(h.queries).toEqual(["campaign_numbers_v2"]); // only one query ran
  });

  it("true when a number is stuck in_progress (lost terminal webhook)", async () => {
    h.responses.push({ count: 0 }, { count: 1 });
    await expect(hasPendingRetry("c1")).resolves.toBe(true);
    expect(h.queries).toHaveLength(2);
  });

  it("false only when BOTH counts are zero", async () => {
    h.responses.push({ count: 0 }, { count: 0 });
    await expect(hasPendingRetry("c1")).resolves.toBe(false);
    expect(h.queries).toHaveLength(2);
  });

  it("false when counts are null with NO error (head:true can return null for zero rows)", async () => {
    h.responses.push({ count: null }, { count: null });
    await expect(hasPendingRetry("c1")).resolves.toBe(false);
  });

  // ── VOZ-365 regression locks ─────────────────────────────────────────────
  // Before the fix both queries destructured only `count`, so an error left it
  // undefined, `(undefined ?? 0) > 0` was false, and the function reported "no work
  // left". Every caller uses that to COMPLETE the campaign — which strands queued
  // retries and, where PAUSE_RELEASES_SLOT is on, also releases the Vapi/SIP slot.
  it("FAIL SAFE: true when the pending_retry count errors, and does not mask it with the 2nd query", async () => {
    h.responses.push({ count: null, error: { message: "connection reset" } });
    await expect(hasPendingRetry("c1")).resolves.toBe(true);
    expect(h.queries).toHaveLength(1); // short-circuits on error
    expect(errSpy).toHaveBeenCalled(); // and logs loudly rather than failing silently
  });

  it("FAIL SAFE: true when the in_progress count errors", async () => {
    h.responses.push({ count: 0 }, { count: null, error: { message: "statement timeout" } });
    await expect(hasPendingRetry("c1")).resolves.toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  it("FAIL SAFE: an error still wins when the count is a real number (error takes precedence)", async () => {
    // Defensive: PostgREST should not return both, but if it does, the error must win —
    // a count returned alongside an error is not trustworthy.
    h.responses.push({ count: 0, error: { message: "partial failure" } });
    await expect(hasPendingRetry("c1")).resolves.toBe(true);
  });
});
