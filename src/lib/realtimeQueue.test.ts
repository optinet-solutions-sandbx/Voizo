import { describe, expect, it } from "vitest";
import { ringsInLabel, shapeQueueRows } from "./realtimeQueue";

const NOW = Date.parse("2026-07-22T08:42:00Z");

describe("shapeQueueRows (VOZ-186 queue visibility)", () => {
  const row = {
    cio_id: "c1",
    display_name: "Jas",
    phone_e164: "+639693381679",
    first_seen_at: "2026-07-22T08:40:34Z",
  };

  it("shapes a waiting member with a call delay → eta = first_seen + delay", () => {
    const [q] = shapeQueueRows([row], 5);
    expect(q).toEqual({
      cioId: "c1",
      displayName: "Jas",
      phone: "+639693381679",
      joinedAt: "2026-07-22T08:40:34Z",
      etaMs: Date.parse("2026-07-22T08:40:34Z") + 5 * 60_000,
    });
  });

  it("no delay configured (cap-gated wait) → etaMs null", () => {
    const [q] = shapeQueueRows([row], null);
    expect(q.etaMs).toBeNull();
  });

  it("nameless member → displayName null, row still shaped", () => {
    const [q] = shapeQueueRows([{ ...row, display_name: null }], 5);
    expect(q.displayName).toBeNull();
    expect(q.phone).toBe("+639693381679");
  });

  it("malformed first_seen_at → etaMs null (fail-closed, no NaN countdown)", () => {
    const [q] = shapeQueueRows([{ ...row, first_seen_at: "garbage" }], 5);
    expect(q.etaMs).toBeNull();
    expect(q.joinedAt).toBe("garbage"); // raw kept for display fallback
  });

  it("sorts oldest-first regardless of input order", () => {
    const later = { ...row, cio_id: "c2", first_seen_at: "2026-07-22T08:41:00Z" };
    const rows = shapeQueueRows([later, row], 5);
    expect(rows.map((r) => r.cioId)).toEqual(["c1", "c2"]);
  });
});

describe("ringsInLabel", () => {
  it("future eta → rings in ~N min (ceil)", () => {
    expect(ringsInLabel(NOW + 3.2 * 60_000, NOW)).toBe("rings in ~4 min");
  });
  it("under a minute → rings in <1 min", () => {
    expect(ringsInLabel(NOW + 30_000, NOW)).toBe("rings in <1 min");
  });
  it("eta passed (promotion imminent) → any moment now", () => {
    expect(ringsInLabel(NOW - 1, NOW)).toBe("any moment now");
  });
  it("no eta (cap-gated) → waiting for a free slot", () => {
    expect(ringsInLabel(null, NOW)).toBe("waiting for a free slot");
  });
});
