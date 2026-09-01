import { describe, it, expect } from "vitest";
import { parseCioEvent, scrubPayload, dedupeKeyOf, CIO_FORBIDDEN_FIELDS } from "./cioEventPayload";

// VOZ-454. The field names Customer.io sends are NOT verified from a captured payload — they come
// from a design discussion. So the contract under test is TOLERANCE: the two fields we control in
// our own Liquid template (cio_id, event_name) are required, and every typed extraction is
// best-effort with NULL for "unknown". Nothing may depend on a guessed field name being right.
//
// This is the lesson from the Mobivate DLR parser, which was written from docs saying JSON when
// reality was a form field `xml=<deliveryreceipt>`: every receipt was dropped for four months.

const RECEIVED_MS = Date.parse("2026-09-01T12:00:00.000Z");
const base = {
  cio_id: "bdba0906bab201dbb00c", // real shape from realtime_seen_members
  event_name: "deposit_made",
};

describe("parseCioEvent — required fields", () => {
  it("accepts the minimum viable body: the two fields our own template controls", () => {
    const r = parseCioEvent(JSON.stringify(base), RECEIVED_MS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.cioId).toBe("bdba0906bab201dbb00c");
    expect(r.event.eventName).toBe("deposit_made");
  });

  it.each([
    ["missing cio_id", { event_name: "deposit_made" }],
    ["blank cio_id", { cio_id: "   ", event_name: "deposit_made" }],
    ["missing event_name", { cio_id: "abc" }],
    ["blank event_name", { cio_id: "abc", event_name: "" }],
    // Both keys form the table's primary key, so neither may be coerced from a number: a cio_id
    // with a leading zero would silently lose it and match no member.
    ["cio_id not a string", { cio_id: 12345, event_name: "deposit_made" }],
    ["event_name not a string", { cio_id: "abc", event_name: 12345 }],
  ])("rejects %s as structurally broken", (_label, body) => {
    const r = parseCioEvent(JSON.stringify(body), RECEIVED_MS);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-JSON body", () => {
    expect(parseCioEvent("not json at all", RECEIVED_MS).ok).toBe(false);
    expect(parseCioEvent("", RECEIVED_MS).ok).toBe(false);
  });

  it("rejects a JSON array or scalar — a body must be an object", () => {
    expect(parseCioEvent("[]", RECEIVED_MS).ok).toBe(false);
    expect(parseCioEvent('"hello"', RECEIVED_MS).ok).toBe(false);
    expect(parseCioEvent("null", RECEIVED_MS).ok).toBe(false);
  });
});

describe("parseCioEvent — occurred_at, the unit trap", () => {
  const at = (v: unknown) => parseCioEvent(JSON.stringify({ ...base, occurred_at: v }), RECEIVED_MS);

  it("reads epoch SECONDS, the documented Customer.io unit", () => {
    const r = at(1788000000); // 2026-09-27T...
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAt.getUTCFullYear()).toBe(2026);
    expect(r.event.occurredAtSource).toBe("payload");
  });

  it("reads epoch seconds sent as a STRING — every CIO attribute is stored as text", () => {
    const r = at("1788000000");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAt.getUTCFullYear()).toBe(2026);
    expect(r.event.occurredAtSource).toBe("payload");
  });

  it("also accepts epoch MILLISECONDS rather than dating the event to the year 57000", () => {
    // The classic ms/s mix-up. Seconds-as-ms lands in 1970; ms-as-seconds lands ~57000. Both are
    // silently wrong and no chart catches it, so the parser disambiguates by magnitude.
    const r = at(1788000000000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Assert the SOURCE and the exact instant, not just the year: the receipt-time fallback also
    // lands in 2026, so a year-only assertion passes even when the ms branch is deleted. (A
    // mutation proved exactly that — the test was being satisfied by the wrong mechanism.)
    expect(r.event.occurredAtSource).toBe("payload");
    expect(r.event.occurredAt.toISOString()).toBe(new Date(1788000000000).toISOString());
  });

  it("accepts an ISO string", () => {
    const r = at("2026-08-30T04:05:06Z");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAt.toISOString()).toBe("2026-08-30T04:05:06.000Z");
  });

  it("falls back to OUR receipt time when the timestamp is absent, and SAYS SO", () => {
    const r = parseCioEvent(JSON.stringify(base), RECEIVED_MS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAt.toISOString()).toBe("2026-09-01T12:00:00.000Z");
    // the provenance marker is the whole point: a receipt time must never masquerade as an event time
    expect(r.event.occurredAtSource).toBe("received");
  });

  it.each([
    ["an insane year", 99999999999999],
    ["a 1970 epoch-zero", 0],
    ["a non-numeric string", "yesterday"],
    ["a negative epoch", -1788000000],
    ["null", null],
  ])("falls back to receipt time for %s", (_label, v) => {
    const r = at(v);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAtSource).toBe("received");
    expect(r.event.occurredAt.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });
});

describe("parseCioEvent — money, best effort and never invented", () => {
  const money = (extra: Record<string, unknown>) =>
    parseCioEvent(JSON.stringify({ ...base, ...extra }), RECEIVED_MS);

  it("normalises the comparable total to a number", () => {
    const r = money({ amount_total: "154.36", currency: "EUR" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.amountNorm).toBe(154.36);
    expect(r.event.currency).toBe("EUR");
  });

  it("keeps the local amount as TEXT, verbatim, never coerced", () => {
    // Held as text on purpose: the Audience surface keeps one figure per currency and must never
    // add AUD to CAD. A number here invites exactly that.
    const r = money({ amount_local: "1,234.50", currency: "AUD" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.amountLocal).toBe("1,234.50");
  });

  it("stores NULL, not 0, when no amount came through", () => {
    const r = money({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // A missing field is UNKNOWN. Zero would read as "they deposited nothing", which is a lie.
    expect(r.event.amountNorm).toBeNull();
    expect(r.event.amountLocal).toBeNull();
    expect(r.event.currency).toBeNull();
  });

  it.each([
    ["no digits at all", "N/A"],
    ["a non-string", {}],
    // These two carry digits, so they survive the early guard and reach the Number() conversion —
    // the branch a mutation showed the other cases never exercise.
    ["digits that are not a number", "1-2-3"],
    ["a stray sign", "--5"],
    ["digits with two decimal points", "1.2.3"],
  ])("stores NULL for %s rather than guessing", (_label, v) => {
    const r = money({ amount_total: v });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Zero would read as "they deposited nothing" — a lie. Unknown must stay unknown.
    expect(r.event.amountNorm).toBeNull();
  });

  it("uppercases the currency code but does not invent one", () => {
    expect((money({ currency: "eur" }) as { ok: true; event: { currency: string | null } }).event.currency).toBe("EUR");
    expect((money({ currency: "" }) as { ok: true; event: { currency: string | null } }).event.currency).toBeNull();
  });
});

describe("dedupeKeyOf — duplicates are certain, not hypothetical", () => {
  it("uses payment_code when present: THE idempotency key", () => {
    // CIO retries and its UI has a Resend button, so the same deposit arrives more than once.
    expect(dedupeKeyOf({ paymentCode: "PC-9931", cioId: "a", eventName: "deposit_made", occurredAt: new Date(0) }))
      .toBe("PC-9931");
  });

  it("is stable across two deliveries of the same event with no payment_code", () => {
    const args = { paymentCode: null, cioId: "a", eventName: "freechip_bonus_issued", occurredAt: new Date("2026-08-30T04:05:06Z") };
    expect(dedupeKeyOf(args)).toBe(dedupeKeyOf({ ...args }));
  });

  it("differs per player, per event name, and per timestamp", () => {
    const b = { paymentCode: null, cioId: "a", eventName: "e", occurredAt: new Date("2026-08-30T04:05:06Z") };
    expect(dedupeKeyOf(b)).not.toBe(dedupeKeyOf({ ...b, cioId: "z" }));
    expect(dedupeKeyOf(b)).not.toBe(dedupeKeyOf({ ...b, eventName: "other" }));
    expect(dedupeKeyOf(b)).not.toBe(dedupeKeyOf({ ...b, occurredAt: new Date("2026-08-30T04:05:07Z") }));
  });

  it("never returns an empty key", () => {
    expect(dedupeKeyOf({ paymentCode: "", cioId: "a", eventName: "e", occurredAt: new Date(0) }).length).toBeGreaterThan(0);
    expect(dedupeKeyOf({ paymentCode: "   ", cioId: "a", eventName: "e", occurredAt: new Date(0) }).trim().length).toBeGreaterThan(0);
  });
});

describe("scrubPayload — the denylist never reaches the database", () => {
  it("drops every forbidden field at the top level", () => {
    const dirty = { cio_id: "a", bin: "411111", ip: "1.2.3.4", phone: "+61400000000", email: "x@y.z", card: "4111", pan: "4111111111111111", amount_total: "10" };
    const clean = scrubPayload(dirty) as Record<string, unknown>;
    for (const f of CIO_FORBIDDEN_FIELDS) expect(clean[f]).toBeUndefined();
    expect(clean.cio_id).toBe("a"); // the join key survives
    expect(clean.amount_total).toBe("10");
  });

  it("drops them NESTED too — a payload is not guaranteed flat", () => {
    const clean = scrubPayload({ outer: { ip_address: "1.2.3.4", keep: 1, deeper: { bin: "x", ok: 2 } } }) as {
      outer: { ip_address?: unknown; keep: number; deeper: { bin?: unknown; ok: number } };
    };
    expect(clean.outer.ip_address).toBeUndefined();
    expect(clean.outer.keep).toBe(1);
    expect(clean.outer.deeper.bin).toBeUndefined();
    expect(clean.outer.deeper.ok).toBe(2);
  });

  it("drops them inside arrays", () => {
    const clean = scrubPayload({ list: [{ ip: "1.2.3.4", keep: 1 }] }) as { list: Array<{ ip?: unknown; keep: number }> };
    expect(clean.list[0].ip).toBeUndefined();
    expect(clean.list[0].keep).toBe(1);
  });

  it("matches field names case-insensitively", () => {
    const clean = scrubPayload({ IP: "1.2.3.4", Email: "x@y.z", BIN: "411111", keep: 1 }) as Record<string, unknown>;
    expect(clean.IP).toBeUndefined();
    expect(clean.Email).toBeUndefined();
    expect(clean.BIN).toBeUndefined();
    expect(clean.keep).toBe(1);
  });

  it("leaves primitives and nulls alone", () => {
    expect(scrubPayload(null)).toBeNull();
    expect(scrubPayload("s")).toBe("s");
    expect(scrubPayload(5)).toBe(5);
  });

  it("is applied by parseCioEvent, so the route cannot forget it", () => {
    const r = parseCioEvent(JSON.stringify({ ...base, ip: "1.2.3.4", bin: "411111" }), RECEIVED_MS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.event.payload as Record<string, unknown>;
    expect(p.ip).toBeUndefined();
    expect(p.bin).toBeUndefined();
    expect(p.cio_id).toBe("bdba0906bab201dbb00c");
  });
});
