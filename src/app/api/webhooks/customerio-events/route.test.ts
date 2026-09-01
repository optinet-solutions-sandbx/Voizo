import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import type { NextRequest } from "next/server";

/**
 * VOZ-454 — the event-ingress route.
 *
 * The contract that matters most is the RESPONSE CODE, because Customer.io stops retrying after
 * about an hour: a 5xx on a business condition loses the event permanently. So every non-our-fault
 * outcome — duplicate, unmatched player, dormant config — must be a 200.
 *
 * Second: `workspace` must come from the VERIFIED SIGNING KEY and never from the body, or a valid
 * signature from one brand could write rows attributed to another.
 */

const KEYS = { lucky7even: "key-l7", fortuneplay: "key-fp" };

const state = vi.hoisted(() => ({
  inserts: [] as Array<Record<string, unknown>>,
  /** null = insert succeeds; set to simulate a DB failure or a PK conflict. */
  insertError: null as { code?: string; message?: string } | null,
}));

vi.mock("../../../../lib/supabaseServer", () => ({
  supabaseAdmin: {
    from: () => ({
      insert: (payload: Record<string, unknown>) => {
        state.inserts.push(payload);
        return Promise.resolve({ error: state.insertError });
      },
    }),
  },
}));

import { POST } from "./route";

const sign = (body: string, ts: string, key: string) =>
  createHmac("sha256", key).update(`v0:${ts}:${body}`).digest("hex");

/** A request whose signature is genuinely valid for `workspace`. */
function req(body: unknown, opts: { workspace?: keyof typeof KEYS; ts?: string; sig?: string | null } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const ws = opts.workspace ?? "lucky7even";
  const sig = opts.sig === undefined ? sign(raw, ts, KEYS[ws]) : opts.sig;
  return {
    text: async () => raw,
    headers: {
      get: (h: string) => {
        const k = h.toLowerCase();
        if (k === "x-cio-timestamp") return ts;
        if (k === "x-cio-signature") return sig;
        return null;
      },
    },
  } as unknown as NextRequest;
}

const GOOD = { cio_id: "bdba0906bab201dbb00c", event_name: "deposit_made", payment_code: "PC-1", amount_total: "154.36", currency: "EUR" };

beforeEach(() => {
  state.inserts = [];
  state.insertError = null;
  process.env.CUSTOMERIO_WEBHOOK_SIGNING_KEYS = JSON.stringify(KEYS);
});

describe("POST /api/webhooks/customerio-events — authenticity", () => {
  it("401s a bad signature and writes nothing", async () => {
    const res = await POST(req(GOOD, { sig: "deadbeef" }));
    expect(res.status).toBe(401);
    expect(state.inserts).toHaveLength(0);
  });

  it("401s a missing signature header", async () => {
    const res = await POST(req(GOOD, { sig: null }));
    expect(res.status).toBe(401);
  });

  it("401s when the key map is unset — a misconfigured env must fail CLOSED", async () => {
    delete process.env.CUSTOMERIO_WEBHOOK_SIGNING_KEYS;
    const res = await POST(req(GOOD));
    expect(res.status).toBe(401);
    expect(state.inserts).toHaveLength(0);
  });

  it("401s a stale timestamp (replay window)", async () => {
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    const res = await POST(req(GOOD, { ts: old }));
    expect(res.status).toBe(401);
  });
});

describe("workspace provenance — the cross-brand write guard", () => {
  it("stores the workspace that the SIGNATURE proves, not one from the body", async () => {
    // Signed with the fortuneplay key while the body claims to be lucky7even.
    const res = await POST(req({ ...GOOD, workspace: "lucky7even" }, { workspace: "fortuneplay" }));
    expect(res.status).toBe(200);
    expect(state.inserts[0].workspace).toBe("fortuneplay");
  });

  it("attributes each brand's delivery to its own key", async () => {
    await POST(req(GOOD, { workspace: "lucky7even" }));
    await POST(req(GOOD, { workspace: "fortuneplay" }));
    expect(state.inserts.map((i) => i.workspace)).toEqual(["lucky7even", "fortuneplay"]);
  });
});

describe("payload handling", () => {
  it("stores a good event and 200s", async () => {
    const res = await POST(req(GOOD));
    expect(res.status).toBe(200);
    expect(state.inserts).toHaveLength(1);
    const row = state.inserts[0];
    expect(row.cio_id).toBe("bdba0906bab201dbb00c");
    expect(row.event_name).toBe("deposit_made");
    expect(row.dedupe_key).toBe("PC-1"); // payment_code is THE idempotency key
    expect(row.amount_norm).toBe(154.36);
    expect(row.currency).toBe("EUR");
  });

  it("400s a structurally broken body so the CIO template error is visible in their UI", async () => {
    const res = await POST(req({ event_name: "deposit_made" })); // no cio_id
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it("400s a non-JSON body", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(400);
  });

  it("never persists a denylisted field, even nested", async () => {
    await POST(req({ ...GOOD, ip: "1.2.3.4", bin: "411111", meta: { email: "x@y.z", keep: 1 } }));
    const stored = JSON.stringify(state.inserts[0].payload);
    expect(stored).not.toContain("1.2.3.4");
    expect(stored).not.toContain("411111");
    expect(stored).not.toContain("x@y.z");
    expect(stored).toContain("keep");
  });

  it("records occurred_at provenance when the payload carries no timestamp", async () => {
    await POST(req(GOOD));
    expect(state.inserts[0].occurred_at_source).toBe("received");
  });

  it("records 'payload' provenance when the timestamp is usable", async () => {
    await POST(req({ ...GOOD, occurred_at: 1788000000 }));
    expect(state.inserts[0].occurred_at_source).toBe("payload");
    expect(String(state.inserts[0].occurred_at)).toContain("2026");
  });
});

describe("retry safety — CIO gives up after ~1 hour, so business conditions are 200", () => {
  it("200s a duplicate (primary-key conflict), not an error", async () => {
    state.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    const res = await POST(req(GOOD));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ duplicate: true });
  });

  it("5xx ONLY when the database genuinely failed, so CIO retries into the PK", async () => {
    state.insertError = { code: "08006", message: "connection failure" };
    const res = await POST(req(GOOD));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("stores an event whose player we have never called instead of dropping it", async () => {
    // Deliberate: an unmatched cio_id is real money data about a real player (e.g. Roosterbet,
    // which had no Voizo CIO segments as of 08-25). The join happens at READ time.
    const res = await POST(req({ ...GOOD, cio_id: "nobody-we-know" }));
    expect(res.status).toBe(200);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].cio_id).toBe("nobody-we-know");
  });
});
