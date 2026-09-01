import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireCallFollowup, VOIZO_CALL_FOLLOWUP } from "./followupEvent";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Email follow-up channel — the dispatch seam.
 *
 * Invariants under test, each one a "when does this fail?" answer:
 *  1. LEDGER BEFORE PROVIDER: the cio_track_events row is written before the Track call, so a
 *     crash between the two leaves a visible 'queued' row — never a silent double-send.
 *  2. THE DOOR: a unique-violation on insert means the follow-up already fired → NO second send.
 *  3. FAIL CLOSED: no Track key (env absent) or no identity → nothing sent, reason returned.
 *  4. NEVER THROWS: every failure (ledger insert error, Track failure, even a throwing supabase
 *     client) collapses to {fired:false} — the end-of-call webhook must be unbreakable from here.
 *  5. The identity ladder: row.cio_id first, else realtime_seen_members by phone (+ write-back).
 */

const ENV_KEYS = JSON.stringify({ lucky7even: "site-l7:key-l7", fortuneplay: "site-fp:key-fp" });

interface MockState {
  inserted: Array<Record<string, unknown>>;
  updated: Array<{ table: string; patch: Record<string, unknown>; id: unknown }>;
  insertError: { code?: string; message?: string } | null;
  seenRow: { cio_id: string } | null;
  fetchCalls: Array<{ url: string; body: unknown }>;
  fetchStatus: number;
}
const S: MockState = { inserted: [], updated: [], insertError: null, seenRow: null, fetchCalls: [], fetchStatus: 200 };

/** Minimal supabase stub covering exactly the three queries fireCallFollowup makes. */
function mockSupabase(): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        S.inserted.push({ __table: table, ...row });
        return Promise.resolve({ error: S.insertError });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: unknown) => {
          S.updated.push({ table, patch, id });
          return Promise.resolve({ error: null });
        },
      }),
      select: () => ({
        eq: () => ({
          not: () => ({
            order: () => ({
              limit: () => Promise.resolve({ data: S.seenRow ? [S.seenRow] : [], error: null }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const realFetch = global.fetch;
beforeEach(() => {
  S.inserted = []; S.updated = []; S.insertError = null; S.seenRow = null; S.fetchCalls = []; S.fetchStatus = 200;
  process.env.CUSTOMERIO_TRACK_API_KEYS = ENV_KEYS;
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    S.fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: S.fetchStatus < 300, status: S.fetchStatus, text: async () => "err-body" } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => { global.fetch = realFetch; });

const ARGS = {
  workspace: "fortuneplay" as string | null,
  campaignId: "camp-1",
  campaignNumberId: "num-1",
  callId: "call-1",
  phone: "+61400000123",
  rowCioId: "bdba0906bab201dbb00c" as string | null,
  callOutcome: "positive",
  smsSent: true,
};

describe("the happy path", () => {
  it("writes the ledger row BEFORE the provider call, then marks it sent", async () => {
    const r = await fireCallFollowup(mockSupabase(), ARGS);
    expect(r).toEqual({ fired: true, reason: "sent" });
    expect(S.inserted).toHaveLength(1);
    const row = S.inserted[0];
    expect(row.__table).toBe("cio_track_events");
    expect(row.status).toBe("queued"); // state before provider — the §6 pattern
    expect(row.workspace).toBe("fortuneplay");
    expect(row.event_name).toBe(VOIZO_CALL_FOLLOWUP);
    expect(row.campaign_number_id).toBe("num-1");
    expect(typeof row.id).toBe("string"); // client-minted id, so the status update needs no read-back
    expect(S.fetchCalls).toHaveLength(1);
    expect(S.fetchCalls[0].url).toContain("cio_bdba0906bab201dbb00c");
    const upd = S.updated.find((u) => u.table === "cio_track_events");
    expect(upd?.patch.status).toBe("sent");
    expect(upd?.id).toBe(row.id);
  });

  it("sends only the approved payload fields — brand, campaign, outcome, sms flag", async () => {
    await fireCallFollowup(mockSupabase(), ARGS);
    const data = (S.fetchCalls[0].body as { data: Record<string, unknown> }).data;
    expect(data).toEqual({
      brand: "fortuneplay",
      campaign_id: "camp-1",
      campaign_number_id: "num-1",
      call_outcome: "positive",
      sms_sent: true,
    });
  });

  it("defaults a null workspace to the default brand, like the SMS sender resolution", async () => {
    await fireCallFollowup(mockSupabase(), { ...ARGS, workspace: null });
    expect(S.inserted[0].workspace).toBe("lucky7even");
  });
});

describe("the door — one follow-up per player, enforced by the database", () => {
  it("a unique-violation means already fired: NO provider call, no error", async () => {
    S.insertError = { code: "23505", message: "duplicate key" };
    const r = await fireCallFollowup(mockSupabase(), ARGS);
    expect(r).toEqual({ fired: false, reason: "duplicate" });
    expect(S.fetchCalls).toHaveLength(0); // the whole point
  });

  it("any other ledger failure also blocks the send — no ledger row, no event, ever", async () => {
    S.insertError = { code: "08006", message: "connection failure" };
    const r = await fireCallFollowup(mockSupabase(), ARGS);
    expect(r).toEqual({ fired: false, reason: "ledger_error" });
    expect(S.fetchCalls).toHaveLength(0);
  });
});

describe("fail closed", () => {
  it("no Track key configured → dormant, nothing written, nothing sent", async () => {
    delete process.env.CUSTOMERIO_TRACK_API_KEYS;
    const r = await fireCallFollowup(mockSupabase(), ARGS);
    expect(r).toEqual({ fired: false, reason: "no_track_key" });
    expect(S.inserted).toHaveLength(0);
    expect(S.fetchCalls).toHaveLength(0);
  });

  it("a workspace with no key entry → dormant for THAT brand only", async () => {
    const r = await fireCallFollowup(mockSupabase(), { ...ARGS, workspace: "roosterbet" });
    expect(r).toEqual({ fired: false, reason: "no_track_key" });
  });

  it("no identity anywhere → no event, and no ledger row either", async () => {
    S.seenRow = null;
    const r = await fireCallFollowup(mockSupabase(), { ...ARGS, rowCioId: null });
    expect(r).toEqual({ fired: false, reason: "no_identity" });
    expect(S.inserted).toHaveLength(0);
    expect(S.fetchCalls).toHaveLength(0);
  });
});

describe("the identity ladder", () => {
  it("rung 2: resolves through realtime_seen_members by phone and writes the id back to the row", async () => {
    S.seenRow = { cio_id: "resolved-from-seen" };
    const r = await fireCallFollowup(mockSupabase(), { ...ARGS, rowCioId: null });
    expect(r).toEqual({ fired: true, reason: "sent" });
    expect(S.fetchCalls[0].url).toContain("cio_resolved-from-seen");
    // self-healing: the resolved id lands back on campaign_numbers_v2
    const writeBack = S.updated.find((u) => u.table === "campaign_numbers_v2");
    expect(writeBack?.patch.cio_id).toBe("resolved-from-seen");
    expect(writeBack?.id).toBe("num-1");
  });

  it("rung 1 wins when the row already carries an id — no lookup, no write-back", async () => {
    S.seenRow = { cio_id: "should-not-be-used" };
    await fireCallFollowup(mockSupabase(), ARGS);
    expect(S.fetchCalls[0].url).toContain("cio_bdba0906bab201dbb00c");
    expect(S.updated.find((u) => u.table === "campaign_numbers_v2")).toBeUndefined();
  });
});

describe("provider failure — recorded, isolated, never thrown", () => {
  it("a Track failure marks the ledger row failed (freeing the door for a retry) and reports it", async () => {
    S.fetchStatus = 401;
    const r = await fireCallFollowup(mockSupabase(), ARGS);
    expect(r).toEqual({ fired: false, reason: "send_failed" });
    const upd = S.updated.find((u) => u.table === "cio_track_events");
    expect(upd?.patch.status).toBe("failed");
    expect(String(upd?.patch.error)).toContain("401");
  });

  it("a supabase client that THROWS still cannot break the caller", async () => {
    const bomb = { from: () => { throw new Error("connection pool exhausted"); } } as unknown as SupabaseClient;
    const r = await fireCallFollowup(bomb, ARGS);
    expect(r.fired).toBe(false);
  });
});
