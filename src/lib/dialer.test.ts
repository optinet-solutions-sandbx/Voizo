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
  responses: [] as Array<{ data?: unknown; count?: number | null; error?: { message: string } | null }>,
  /** Table names touched, in order — lets us assert short-circuiting AND re-fetching. */
  queries: [] as string[],
  /** Every .update() that reached a terminal .eq()/.in(), so we can assert what was written. */
  updates: [] as Array<{ table: string; payload: Record<string, unknown>; ids: unknown }>,
}));

vi.mock("./supabaseServer", () => {
  const CHAIN = ["select", "gt", "lt", "gte", "lte", "is", "not", "or", "order", "limit", "single", "maybeSingle"];
  function builder(table: string) {
    h.queries.push(table);
    // `update()` is deferred until the terminal filter so we capture BOTH the payload
    // and which rows it targeted — that is the whole point of these assertions.
    let pendingUpdate: Record<string, unknown> | null = null;
    const capture = (ids: unknown) => {
      if (pendingUpdate) {
        h.updates.push({ table, payload: pendingUpdate, ids });
        pendingUpdate = null;
      }
    };
    const chain: Record<string, unknown> = {
      // Thenable: awaiting the builder resolves the next scripted response.
      then(resolve: (v: unknown) => void) {
        const next = h.responses.shift() ?? { count: 0, error: null };
        resolve({ data: next.data ?? null, count: next.count ?? null, error: next.error ?? null });
      },
      update(payload: Record<string, unknown>) {
        pendingUpdate = payload;
        return chain;
      },
      eq(_col: string, val: unknown) {
        capture(val);
        return chain;
      },
      in(_col: string, vals: unknown) {
        capture(vals);
        return chain;
      },
    };
    for (const m of CHAIN) chain[m] = () => chain;
    return chain;
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } };
});

import { hasPendingRetry, findNextNumber } from "./dialer";

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.responses.length = 0;
  h.queries.length = 0;
  h.updates.length = 0;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errSpy.mockRestore());

// ── findNextNumber helpers ────────────────────────────────────────────────
// Query order per window pass: campaigns_v2(max_attempts) once, then per pass
// campaign_numbers_v2(window) -> suppression_list -> do_not_call -> [update].
// Promise.all calls .then in array order, so suppression_list always shifts first.
const num = (id: string, phone: string, extra: Record<string, unknown> = {}) => ({
  id,
  phone_e164: phone,
  outcome: "pending",
  next_attempt_at: null,
  attempt_count: 0,
  ...extra,
});
/** Scripts one full window pass. `blockedV2`/`blockedV1` are phone strings. */
const windowPass = (
  rows: ReturnType<typeof num>[],
  blockedV2: string[] = [],
  blockedV1: string[] = [],
  updateResult: { error?: { message: string } | null } = {},
) => {
  // Mirror the implementation exactly: an update only fires when at least one blocked
  // number PRECEDES the first clean one. Getting this wrong would shift every later
  // scripted response by one and silently invalidate the test.
  const blocked = new Set([...blockedV2, ...blockedV1]);
  const firstClean = rows.findIndex((r) => !blocked.has(r.phone_e164));
  const toSuppress = firstClean === -1 ? rows : rows.slice(0, firstClean);
  const out: Array<Record<string, unknown>> = [
    { data: rows },
    { data: blockedV2.map((p) => ({ phone_e164: p })) },
    { data: blockedV1.map((p) => ({ phone_number: p })) },
  ];
  if (toSuppress.length > 0) out.push({ data: null, ...updateResult });
  return out;
};
const CAMPAIGN = { data: { max_attempts: 3 } };

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

describe("findNextNumber — suppression gate (VOZ-364) + loop, not recursion (VOZ-365 #2)", () => {
  it("returns the first candidate when nothing is suppressed, and writes nothing", async () => {
    h.responses.push(CAMPAIGN, ...windowPass([num("n1", "+1"), num("n2", "+2")]));
    const got = await findNextNumber("c1");
    expect((got as { id: string }).id).toBe("n1");
    expect(h.updates).toEqual([]);
  });

  it("skips suppressed numbers and marks EXACTLY those skipped — in ONE update, with NO re-fetch", async () => {
    h.responses.push(
      CAMPAIGN,
      ...windowPass([num("n1", "+1"), num("n2", "+2"), num("n3", "+3")], ["+1", "+2"]),
    );
    const got = await findNextNumber("c1");
    expect((got as { id: string }).id).toBe("n3");

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].payload).toEqual({ outcome: "suppressed" });
    expect(h.updates[0].ids).toEqual(["n1", "n2"]);

    // THE VOZ-365 #2 REGRESSION LOCK. The old code recursed once per suppressed
    // number, so skipping two cost THREE window fetches and three campaign lookups.
    expect(h.queries.filter((q) => q === "campaign_numbers_v2")).toHaveLength(2); // window + update
    expect(h.queries.filter((q) => q === "campaigns_v2")).toHaveLength(1);
  });

  it("do_not_call (V1) blocks too — either table suppresses", async () => {
    h.responses.push(
      CAMPAIGN,
      ...windowPass([num("n1", "+1"), num("n2", "+2")], [], ["+1"]),
    );
    const got = await findNextNumber("c1");
    expect((got as { id: string }).id).toBe("n2");
    expect(h.updates[0].ids).toEqual(["n1"]);
  });

  it("an ENTIRELY suppressed window re-fetches the next one (keeps the old past-20 behaviour)", async () => {
    h.responses.push(
      CAMPAIGN,
      ...windowPass([num("a1", "+1"), num("a2", "+2")], ["+1", "+2"]),
      ...windowPass([num("b1", "+9")]),
    );
    const got = await findNextNumber("c1");
    expect((got as { id: string }).id).toBe("b1");
    expect(h.updates[0].ids).toEqual(["a1", "a2"]);
  });

  // ── VOZ-364: the compliance gate must fail CLOSED ────────────────────────
  // Before the fix both lookups destructured only `data`. An error left data null,
  // which read as "not suppressed", and the number was DIALLED — a DB blip became a
  // call to a do-not-call number. These two lock the direction.
  it("FAIL CLOSED: a suppression_list error does NOT dial — it defers and burns no attempt", async () => {
    h.responses.push(
      CAMPAIGN,
      { data: [num("n1", "+1"), num("n2", "+2")] },
      { data: null, error: { message: "connection reset" } }, // suppression_list
      { data: [] }, // do_not_call still resolves under Promise.all
      { data: null }, // the defer write
    );
    await expect(findNextNumber("c1")).resolves.toBeNull();

    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].ids).toBe("n1");
    expect(h.updates[0].payload.outcome).toBe("pending_retry");
    expect(typeof h.updates[0].payload.next_attempt_at).toBe("string");
    // no attempt_count increment anywhere — VOZ-321 no-burn semantics
    expect(h.updates[0].payload).not.toHaveProperty("attempt_count");
    expect(errSpy).toHaveBeenCalled();
  });

  it("FAIL CLOSED: a do_not_call error also defers rather than dialling", async () => {
    h.responses.push(
      CAMPAIGN,
      { data: [num("n1", "+1")] },
      { data: [] }, // suppression_list clean
      { data: null, error: { message: "statement timeout" } }, // do_not_call errors
      { data: null }, // defer write
    );
    await expect(findNextNumber("c1")).resolves.toBeNull();
    expect(h.updates[0].payload.outcome).toBe("pending_retry");
  });

  it("a failed suppression WRITE still returns a number we positively verified as clean", async () => {
    h.responses.push(
      CAMPAIGN,
      ...windowPass([num("n1", "+1"), num("n2", "+2")], ["+1"], [], { error: { message: "deadlock" } }),
    );
    const got = await findNextNumber("c1");
    expect((got as { id: string }).id).toBe("n2"); // bookkeeping failure must not stall dialing
    expect(errSpy).toHaveBeenCalled();
  });

  it("a failed suppression WRITE with nothing clean defers instead of spinning forever", async () => {
    // The old recursion re-fetched an identical window here and never terminated.
    h.responses.push(
      CAMPAIGN,
      ...windowPass([num("n1", "+1")], ["+1"], [], { error: { message: "deadlock" } }),
      { data: null }, // defer write
    );
    await expect(findNextNumber("c1")).resolves.toBeNull();
    expect(h.updates.at(-1)?.payload.outcome).toBe("pending_retry");
  });

  it("ACCEPTANCE (VOZ-365 #2): 5,000 suppressed candidates complete without stack growth", async () => {
    h.responses.push(CAMPAIGN);
    for (let w = 0; w < 250; w++) {
      const rows = Array.from({ length: 20 }, (_, i) => num(`s${w}-${i}`, `+s${w}-${i}`));
      h.responses.push(...windowPass(rows, rows.map((r) => r.phone_e164)));
    }
    h.responses.push(...windowPass([num("clean", "+clean")]));

    const got = await findNextNumber("c1"); // recursion would RangeError long before here
    expect((got as { id: string }).id).toBe("clean");
    expect(h.updates).toHaveLength(250); // one batched update per window, not one per number
  });
});
