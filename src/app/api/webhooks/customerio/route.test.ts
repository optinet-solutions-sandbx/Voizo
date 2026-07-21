import { createHmac } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// ── Fake supabase (same recorder pattern as realtimeAdmission.test.ts) ────
interface Op {
  table: string;
  calls: Array<{ method: string; args: unknown[] }>;
}
function makeFakeDb(responses: Array<{ data?: unknown; error?: unknown; count?: number }>) {
  const ops: Op[] = [];
  const queue = [...responses];
  return {
    ops,
    from(table: string) {
      const op: Op = { table, calls: [] };
      ops.push(op);
      const chain: Record<string, unknown> = {
        then(resolve: (v: unknown) => void) {
          const next = queue.shift() ?? { data: null, error: null };
          resolve({ data: next.data ?? null, error: next.error ?? null, count: next.count ?? null });
        },
      };
      for (const m of ["select", "eq", "in", "gte", "lt", "limit", "order", "maybeSingle", "upsert", "insert", "update", "delete"]) {
        chain[m] = (...args: unknown[]) => {
          op.calls.push({ method: m, args });
          return chain;
        };
      }
      return chain;
    },
  };
}

// vi.mock factories are hoisted — shared mutable state must come from vi.hoisted.
const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof makeFakeDb> }));
vi.mock("../../../../lib/supabaseServer", () => ({
  supabaseAdmin: { from: (t: string) => h.db.from(t) },
}));
vi.mock("../../../../lib/alerts/slack", () => ({
  postSlackAlert: vi.fn(async () => {}),
}));

import { POST } from "./route";
import { postSlackAlert } from "../../../../lib/alerts/slack";

// ── Request helper: signs the way Customer.io does ────────────────────────
const KEY = "test-key-lucky7even";
function signedReq(bodyObj: unknown, opts: { key?: string; tsOffsetSec?: number; rawOverride?: string } = {}): NextRequest {
  const raw = opts.rawOverride ?? JSON.stringify(bodyObj);
  const ts = Math.floor(Date.now() / 1000) + (opts.tsOffsetSec ?? 0);
  const sig = createHmac("sha256", opts.key ?? KEY).update(`v0:${ts}:${raw}`).digest("hex");
  return {
    headers: new Headers({ "x-cio-timestamp": String(ts), "x-cio-signature": sig }),
    text: async () => raw,
  } as unknown as NextRequest;
}

const PAYLOAD = { cio_id: "cio-9", phone: "+61412345678", first_name: "Maria", segment_id: 42 };
const PARENT = { id: "parent-1", name: "RT AU", timezone: "Australia/Sydney", segment_id: 42, call_delay_minutes: null };
const CHILD = { id: "child-1", name: "RT AU child", daily_cap: null };

function claimUpsertPayload(ops: Op[]): Record<string, unknown> | null {
  const op = ops.find((o) => o.table === "realtime_seen_members" && o.calls.some((c) => c.method === "upsert"));
  if (!op) return null;
  return op.calls.find((c) => c.method === "upsert")!.args[0] as Record<string, unknown>;
}
function dialInsertPayload(ops: Op[]): Record<string, unknown> | null {
  // NB: the addedToday cap check also touches campaign_numbers_v2 (select/count)
  // — only an op with an actual `insert` call is a dial row.
  const op = ops.find((o) => o.table === "campaign_numbers_v2" && o.calls.some((c) => c.method === "insert"));
  if (!op) return null;
  return op.calls.find((c) => c.method === "insert")!.args[0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMERIO_WEBHOOK_SIGNING_KEYS = JSON.stringify({ lucky7even: KEY });
  h.db = makeFakeDb([]);
});

describe("POST /api/webhooks/customerio — the front door", () => {
  it("401s an unsigned/garbage request without touching the database", async () => {
    const req = { headers: new Headers(), text: async () => "{}" } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(h.db.ops).toHaveLength(0);
  });

  it("401s a signature from an unknown key", async () => {
    const res = await POST(signedReq(PAYLOAD, { key: "wrong-key" }));
    expect(res.status).toBe(401);
    expect(h.db.ops).toHaveLength(0);
  });

  it("401s a stale timestamp (replay)", async () => {
    const res = await POST(signedReq(PAYLOAD, { tsOffsetSec: -10 * 60 }));
    expect(res.status).toBe(401);
  });

  it("fails CLOSED when the keys env is unset", async () => {
    delete process.env.CUSTOMERIO_WEBHOOK_SIGNING_KEYS;
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(401);
  });

  it("400s a structurally-broken payload (missing phone key = broken template)", async () => {
    const res = await POST(signedReq({ cio_id: "c1", segment_id: 42 }));
    expect(res.status).toBe(400);
    expect(h.db.ops).toHaveLength(0); // must NOT claim anyone off a broken template
  });

  it("400s non-JSON and missing cio_id/segment_id", async () => {
    expect((await POST(signedReq(null, { rawOverride: "not json" }))).status).toBe(400);
    expect((await POST(signedReq({ phone: "+61412345678", segment_id: 42 }))).status).toBe(400);
    expect((await POST(signedReq({ cio_id: "c1", phone: "+61412345678" }))).status).toBe(400);
  });

  it("400s a non-integer segment_id instead of 500ing on the DB cast", async () => {
    expect((await POST(signedReq({ ...PAYLOAD, segment_id: 3.5 }))).status).toBe(400);
    expect(h.db.ops).toHaveLength(0);
  });
});

describe("POST /api/webhooks/customerio — admission", () => {
  it("200-noops when no running realtime parent matches the segment (dormant-safe)", async () => {
    h.db = makeFakeDb([{ data: [] }]); // parents query → none
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handled).toBe(false);
  });

  it("queues a valid new player into today's (uncapped) child with their name", async () => {
    h.db = makeFakeDb([
      { data: [PARENT] },              // parents
      { data: CHILD },                 // today's child
      { data: [{ cio_id: "cio-9" }] }, // claim won
      { error: null },                 // dial-row insert
    ]);
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handled).toBe(true);
    expect(body.results[0].outcome).toBe("queued");
    expect(claimUpsertPayload(h.db.ops)).toMatchObject({ status: "queued", display_name: "Maria" });
    expect(dialInsertPayload(h.db.ops)).toMatchObject({
      campaign_id: "child-1",
      phone_e164: "+61412345678",
      display_name: "Maria",
    });
  });

  it("a Customer.io retry / duplicate push is a silent 200 no-op (claim lost)", async () => {
    h.db = makeFakeDb([
      { data: [PARENT] },
      { data: CHILD },
      { data: [] }, // claim RETURNING empty → already claimed
    ]);
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].outcome).toBe("duplicate");
    expect(dialInsertPayload(h.db.ops)).toBeNull();
  });

  it("buffers as 'waiting' whenever the child is capped — the poll's sequential promotion pass enforces the cap", async () => {
    h.db = makeFakeDb([
      { data: [PARENT] },
      { data: { ...CHILD, daily_cap: 5 } },
      { data: [{ cio_id: "cio-9" }] }, // waiting claim won
    ]);
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].outcome).toBe("waiting");
    expect(claimUpsertPayload(h.db.ops)).toMatchObject({ status: "waiting", child_campaign_id: null });
    // NEVER reads or writes campaign_numbers_v2: a webhook-side count-then-insert
    // is a TOCTOU race across concurrent deliveries — a burst would blow the cap.
    expect(h.db.ops.every((o) => o.table !== "campaign_numbers_v2")).toBe(true);
  });

  it("buffers as 'waiting' when no child exists today (overnight / off-day)", async () => {
    h.db = makeFakeDb([
      { data: [PARENT] },
      { data: null },                  // no child today
      { data: [{ cio_id: "cio-9" }] }, // waiting claim won
    ]);
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].outcome).toBe("waiting");
  });

  it("respects the operator call delay (waiting even with room in the child)", async () => {
    h.db = makeFakeDb([
      { data: [{ ...PARENT, call_delay_minutes: 30 }] },
      { data: CHILD },
      { data: [{ cio_id: "cio-9" }] },
    ]);
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].outcome).toBe("waiting");
  });

  it("defers a wrong-country payload phone to the poll — no claim, no per-member Slack", async () => {
    h.db = makeFakeDb([{ data: [PARENT] }]); // AU parent
    const res = await POST(signedReq({ ...PAYLOAD, phone: "+14165550123" })); // CA number in AU campaign
    expect(res.status).toBe(200);
    // The poll re-resolves with authoritative profile attrs (the payload phone
    // may be stale) and owns the batched wrong-country alert.
    expect((await res.json()).results[0].outcome).toBe("deferred_to_poll");
    expect(claimUpsertPayload(h.db.ops)).toBeNull();
    expect(postSlackAlert).not.toHaveBeenCalled();
  });

  it("defers an empty payload phone to the poll instead of permanently claiming no_phone", async () => {
    // A blank liquid render ({{customer.phone}} on a workspace using another
    // attr name) must never tombstone the member — the poll's profile-lookup
    // fallback (spec §5.3) can still find their real phone.
    h.db = makeFakeDb([{ data: [PARENT] }]);
    const res = await POST(signedReq({ ...PAYLOAD, phone: "" }));
    expect(res.status).toBe(200);
    expect((await res.json()).results[0].outcome).toBe("deferred_to_poll");
    expect(claimUpsertPayload(h.db.ops)).toBeNull();
  });

  it("500s when the parents query itself fails (we're broken → let CIO retry)", async () => {
    h.db = makeFakeDb([{ data: null, error: { message: "db down" } }]);
    const res = await POST(signedReq(PAYLOAD));
    expect(res.status).toBe(500);
  });
});
