import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { claimAndQueueMember, findTodaysChild, promoteWaitingMember } from "./realtimeAdmission";

// ── Fake supabase ─────────────────────────────────────────────────────────
// Chainable recorder: every method returns the same thenable builder; awaiting
// it pops the next scripted response. The op log lets tests assert exactly
// which tables/payloads were touched, in order.

interface Op {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}

function fakeDb(responses: Array<{ data?: unknown; error?: unknown; count?: number }>) {
  const ops: Op[] = [];
  const queue = [...responses];
  function builder(table: string) {
    const op: Op = { table, calls: [] };
    ops.push(op);
    const chain: Record<string, unknown> = {
      then(resolve: (v: unknown) => void) {
        const next = queue.shift() ?? { data: null, error: null };
        resolve({ data: next.data ?? null, error: next.error ?? null, count: next.count ?? null });
      },
    };
    for (const m of ["upsert", "insert", "update", "delete", "select", "eq", "in", "gte", "lt", "order", "limit", "maybeSingle"]) {
      chain[m] = (...args: unknown[]) => {
        op.calls.push({ method: m, args });
        return chain;
      };
    }
    return chain;
  }
  const client = { from: (table: string) => builder(table) } as unknown as SupabaseClient;
  return { client, ops };
}

const ARGS = {
  parentId: "parent-1",
  parentName: "RT AU",
  cioId: "cio-9",
  phone: "+61412345678",
  displayName: "Maria",
};

function callsOf(op: Op, method: string) {
  return op.calls.filter((c) => c.method === method);
}

// ── findTodaysChild ───────────────────────────────────────────────────────

describe("findTodaysChild", () => {
  it("queries today's child with the canonical statuses and day window", async () => {
    const { client, ops } = fakeDb([{ data: { id: "child-1", name: "RT child", daily_cap: 100 } }]);
    const res = await findTodaysChild(client, "parent-1", "Australia/Sydney", new Date("2026-07-21T03:00:00Z"));
    expect(res).toEqual({ ok: true, child: { id: "child-1", name: "RT child", daily_cap: 100 } });

    expect(ops[0].table).toBe("campaigns_v2");
    const inCall = callsOf(ops[0], "in")[0];
    expect(inCall.args).toEqual(["status", ["draft", "running", "paused"]]);
    // Day window computed in the PARENT's timezone (AEST day, not UTC's).
    const gte = callsOf(ops[0], "gte")[0].args as [string, string];
    const lt = callsOf(ops[0], "lt")[0].args as [string, string];
    expect(gte[0]).toBe("start_at");
    expect(lt[0]).toBe("start_at");
    expect(new Date(gte[1]).getTime()).toBeLessThan(new Date(lt[1]).getTime());
  });

  it("returns ok with child:null when no child exists today (not an error)", async () => {
    const { client } = fakeDb([{ data: null }]);
    const res = await findTodaysChild(client, "parent-1", "Australia/Sydney", new Date());
    expect(res).toEqual({ ok: true, child: null });
  });

  it("returns ok:false on a query error", async () => {
    const { client } = fakeDb([{ data: null, error: { message: "db down" } }]);
    const res = await findTodaysChild(client, "parent-1", "Australia/Sydney", new Date());
    expect(res).toEqual({ ok: false, child: null });
  });
});

// ── claimAndQueueMember ───────────────────────────────────────────────────

describe("claimAndQueueMember", () => {
  it("wins the claim and inserts the dial row with the name → queued", async () => {
    const { client, ops } = fakeDb([
      { data: [{ cio_id: "cio-9" }] }, // claim upsert RETURNING → won
      { error: null },                 // dial-row insert
    ]);
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "queued", childId: "child-1" });
    expect(res).toEqual({ won: true, queued: true });

    expect(ops[0].table).toBe("realtime_seen_members");
    const upsertPayload = callsOf(ops[0], "upsert")[0].args[0] as Record<string, unknown>;
    expect(upsertPayload).toMatchObject({
      parent_campaign_id: "parent-1",
      cio_id: "cio-9",
      phone_e164: "+61412345678",
      status: "queued",
      child_campaign_id: "child-1",
      display_name: "Maria",
    });
    const upsertOpts = callsOf(ops[0], "upsert")[0].args[1] as Record<string, unknown>;
    expect(upsertOpts).toMatchObject({ onConflict: "parent_campaign_id,cio_id", ignoreDuplicates: true });

    expect(ops[1].table).toBe("campaign_numbers_v2");
    const dialRow = callsOf(ops[1], "insert")[0].args[0] as Record<string, unknown>;
    expect(dialRow).toMatchObject({
      campaign_id: "child-1",
      phone_e164: "+61412345678",
      outcome: "pending",
      display_name: "Maria",
    });
  });

  it("loses the claim (another tick got there) → duplicate, NO dial row", async () => {
    const { client, ops } = fakeDb([{ data: [] }]); // RETURNING empty = lost
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "queued", childId: "child-1" });
    expect(res).toEqual({ won: false, reason: "duplicate" });
    expect(ops).toHaveLength(1); // only the claim attempt — never touched campaign_numbers_v2
  });

  it("compensates a failed dial-row insert by releasing the claim → insert_failed", async () => {
    const { client, ops } = fakeDb([
      { data: [{ cio_id: "cio-9" }] },      // claim won
      { error: { message: "insert boom" } }, // dial-row insert fails
      { error: null },                       // compensating delete
    ]);
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "queued", childId: "child-1" });
    expect(res).toEqual({ won: false, reason: "insert_failed" });
    expect(ops[2].table).toBe("realtime_seen_members");
    expect(callsOf(ops[2], "delete")).toHaveLength(1);
  });

  it("treats a duplicate-phone violation (23505) as already-queued success — claim kept", async () => {
    const { client, ops } = fakeDb([
      { data: [{ cio_id: "cio-9" }] },                        // claim won
      { error: { code: "23505", message: "duplicate key" } }, // phone already in child
    ]);
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "queued", childId: "child-1" });
    expect(res).toEqual({ won: true, queued: true });
    // NO compensating delete: releasing would loop claim→violate→release
    // forever (webhook 500s + poll re-erroring every tick).
    expect(ops).toHaveLength(2);
  });

  it("claims 'waiting' with the name kept and NO dial row / NO child binding", async () => {
    const { client, ops } = fakeDb([{ data: [{ cio_id: "cio-9" }] }]);
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "waiting", childId: null });
    expect(res).toEqual({ won: true, queued: false });
    const upsertPayload = callsOf(ops[0], "upsert")[0].args[0] as Record<string, unknown>;
    expect(upsertPayload).toMatchObject({ status: "waiting", child_campaign_id: null, display_name: "Maria" });
    expect(ops).toHaveLength(1);
  });

  it("claims set-aside statuses (rejected_country) without a dial row", async () => {
    const { client, ops } = fakeDb([{ data: [{ cio_id: "cio-9" }] }]);
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "rejected_country", childId: null });
    expect(res).toEqual({ won: true, queued: false });
    expect(ops).toHaveLength(1);
  });

  it("claim upsert error → claim_error (member retryable next tick)", async () => {
    const { client, ops } = fakeDb([{ data: null, error: { message: "db down" } }]);
    const res = await claimAndQueueMember(client, { ...ARGS, claimStatus: "queued", childId: "child-1" });
    expect(res).toEqual({ won: false, reason: "claim_error" });
    expect(ops).toHaveLength(1);
  });
});

// ── promoteWaitingMember ──────────────────────────────────────────────────

describe("promoteWaitingMember", () => {
  const W = {
    parentId: "parent-1",
    parentName: "RT AU",
    cioId: "cio-9",
    phone: "+61412345678",
    displayName: "Maria",
    childId: "child-1",
  };

  it("wins the waiting→queued flip and inserts the dial row WITH the name", async () => {
    const { client, ops } = fakeDb([
      { data: [{ cio_id: "cio-9" }] }, // update RETURNING → won flip
      { error: null },                 // dial-row insert
    ]);
    const res = await promoteWaitingMember(client, W);
    expect(res).toBe("promoted");

    const updatePayload = callsOf(ops[0], "update")[0].args[0] as Record<string, unknown>;
    expect(updatePayload).toMatchObject({ status: "queued", child_campaign_id: "child-1" });
    const dialRow = callsOf(ops[1], "insert")[0].args[0] as Record<string, unknown>;
    expect(dialRow).toMatchObject({
      campaign_id: "child-1",
      phone_e164: "+61412345678",
      outcome: "pending",
      display_name: "Maria",
    });
  });

  it("loses the flip (another tick promoted them) → skipped, no insert", async () => {
    const { client, ops } = fakeDb([{ data: [] }]);
    const res = await promoteWaitingMember(client, W);
    expect(res).toBe("skipped");
    expect(ops).toHaveLength(1);
  });

  it("treats a duplicate-phone violation (23505) as promoted — no flip-back", async () => {
    const { client, ops } = fakeDb([
      { data: [{ cio_id: "cio-9" }] },                        // flip won
      { error: { code: "23505", message: "duplicate key" } }, // phone already in child
    ]);
    const res = await promoteWaitingMember(client, W);
    expect(res).toBe("promoted");
    expect(ops).toHaveLength(2); // no flip-back — the phone IS queued in this child
  });

  it("flips back to waiting when the dial-row insert fails (delay clock untouched)", async () => {
    const { client, ops } = fakeDb([
      { data: [{ cio_id: "cio-9" }] },     // flip won
      { error: { message: "insert boom" } }, // insert fails
      { error: null },                     // compensating flip-back
    ]);
    const res = await promoteWaitingMember(client, W);
    expect(res).toBe("failed");
    const flipBack = callsOf(ops[2], "update")[0].args[0] as Record<string, unknown>;
    expect(flipBack).toMatchObject({ status: "waiting", child_campaign_id: null });
  });
});
