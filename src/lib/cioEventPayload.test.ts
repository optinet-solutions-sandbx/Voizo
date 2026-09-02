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

// VOZ-476 (2) — created_at is the field Customer.io actually sends. The captured deposit_made body
// carries created_at + finished_at; occurred_at / timestamp / event_timestamp are the names the
// parser was written against, and none of them appear.
describe("parseCioEvent — created_at, the name CIO really uses", () => {
  const body = (extra: Record<string, unknown>) =>
    parseCioEvent(JSON.stringify({ ...base, ...extra }), RECEIVED_MS);

  it("reads created_at as epoch seconds — the deposit_made shape", () => {
    const r = body({ created_at: 1788000000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAt.toISOString()).toBe("2026-08-29T10:40:00.000Z");
    expect(r.event.occurredAtSource).toBe("payload");
  });

  it("reads created_at as a HUMAN STRING — the deposit_canceled shape, same field name", () => {
    // The same attribute arrives as an epoch int on deposit_made and as prose on deposit_canceled.
    // The band-checked multi-format path already copes; this pins that it must keep coping.
    const r = body({ created_at: "August 10, 2026 07:58" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAtSource).toBe("payload");
    expect(r.event.occurredAt.getUTCFullYear()).toBe(2026);
    expect(r.event.occurredAt.getUTCMonth()).toBe(7); // August
  });

  it("prefers occurred_at when BOTH are present — our own template stays authoritative", () => {
    const r = body({ occurred_at: "2026-08-30T04:05:06Z", created_at: 1788000000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAt.toISOString()).toBe("2026-08-30T04:05:06.000Z");
  });

  // THE case the ticket is actually about. Liquid renders a missing variable as an empty string, so
  // a template with "occurred_at": "{{event.timestamp}}" and no event.timestamp sends occurred_at:"".
  // `??` only falls through on null/undefined, so "" would win the chain, fail to parse, and the
  // event would be stamped with OUR clock while created_at sat unread in the same body.
  it("falls through an occurred_at that is present but UNPARSEABLE, and finds created_at", () => {
    const r = body({ occurred_at: "", created_at: 1788000000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAtSource).toBe("payload");
    expect(r.event.occurredAt.toISOString()).toBe("2026-08-29T10:40:00.000Z");
  });

  it.each([
    ["an unrendered Liquid tag", "{{event.timestamp}}"],
    ["a blank string", "   "],
    ["an out-of-band year", 99999999999999],
  ])("falls through occurred_at = %s to reach created_at", (_label, bad) => {
    const r = body({ occurred_at: bad, created_at: 1788000000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAtSource).toBe("payload");
    expect(r.event.occurredAt.toISOString()).toBe("2026-08-29T10:40:00.000Z");
  });

  it("still falls back to receipt time when EVERY candidate is unbelievable", () => {
    const r = body({ occurred_at: "", timestamp: "nope", event_timestamp: null, created_at: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.occurredAtSource).toBe("received");
    expect(r.event.occurredAt.toISOString()).toBe("2026-09-01T12:00:00.000Z");
  });
});

// VOZ-476 (1) — the proven collision. Two segment_entered events one second apart in Jasiel's own
// profile screenshots ("Entered 1 and exited 6 segment(s)"), so same-second bursts are routine.
describe("parseCioEvent — an explicit dedupe_key from the body", () => {
  const body = (extra: Record<string, unknown>) =>
    parseCioEvent(JSON.stringify({ ...base, ...extra }), RECEIVED_MS);

  it("carries dedupe_key through when the template sets one", () => {
    const r = body({ dedupe_key: "abc-seg-4DEP-1788000000" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.dedupeKey).toBe("abc-seg-4DEP-1788000000");
  });

  it("is NULL when absent, so the fallback chain is unchanged", () => {
    expect((body({}) as { ok: true; event: { dedupeKey: string | null } }).event.dedupeKey).toBeNull();
  });

  it.each([
    ["blank", "   "],
    ["empty", ""],
    ["a number", 12345],
    ["an object", {}],
  ])("ignores a %s dedupe_key rather than keying on junk", (_label, v) => {
    expect((body({ dedupe_key: v }) as { ok: true; event: { dedupeKey: string | null } }).event.dedupeKey).toBeNull();
  });
});

describe("dedupeKeyOf — VOZ-476: the segment_entered collision", () => {
  // Reproduces the collision recorded on the ticket against the SHIPPED code: same player, same
  // event name, same second, different segment -> one identical key -> the second row refused.
  const sameSecond = {
    paymentCode: null,
    cioId: "83da08078f3be0a30d",
    eventName: "segment_entered",
    occurredAt: new Date("2026-09-02T02:31:09.000Z"),
  };

  it("still collides when the template supplies NO dedupe_key — the documented ceiling", () => {
    expect(dedupeKeyOf(sameSecond)).toBe(dedupeKeyOf({ ...sameSecond }));
  });

  it("separates them once the template supplies one", () => {
    const a = dedupeKeyOf({ ...sameSecond, dedupeKey: "83da…-seg-Players with 4+ DEP-1788000669" });
    const b = dedupeKeyOf({ ...sameSecond, dedupeKey: "83da…-seg-CP count <25-1788000669" });
    expect(a).not.toBe(b);
    expect(a).toBe("83da…-seg-Players with 4+ DEP-1788000669");
  });

  it("OUTRANKS payment_code — the template is the single authority on uniqueness", () => {
    expect(dedupeKeyOf({ ...sameSecond, paymentCode: "PC-9931", dedupeKey: "explicit-wins" }))
      .toBe("explicit-wins");
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["blank", "   "],
    ["empty", ""],
  ])("falls back to payment_code when dedupeKey is %s", (_label, v) => {
    expect(dedupeKeyOf({ ...sameSecond, paymentCode: "PC-9931", dedupeKey: v }))
      .toBe("PC-9931");
  });

  it("falls all the way to the hash when neither is usable", () => {
    const k = dedupeKeyOf({ ...sameSecond, dedupeKey: "  ", paymentCode: "  " });
    expect(k).toHaveLength(64); // sha256 hex
  });

  it("trims an explicit key, so trailing whitespace cannot mint a second row", () => {
    expect(dedupeKeyOf({ ...sameSecond, dedupeKey: "  k-1  " })).toBe("k-1");
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
