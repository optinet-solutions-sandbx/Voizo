import { describe, it, expect } from "vitest";
import { freeMaintenanceSlot } from "./sipPool";

// VOZ-319: release_vapi_sip_slot only frees status='leased' rows, so heartbeat
// Rule 4 (which feeds it 'maintenance' slots) could never succeed — the retry
// loop was unwinnable. freeMaintenanceSlot is the path-local completion:
// a guarded UPDATE that flips maintenance→free and reports whether a row moved.
//
// fakeSupabase mirrors the .from().update().eq().eq().select() chain the real
// client builds. `matched` is what the guarded WHERE found: a row (the slot was
// still in maintenance) or nothing (already free / leased / wrong id).
function fakeSupabase(matched: boolean, error: { message: string } | null = null) {
  const result = Promise.resolve({ data: error ? null : matched ? [{ id: "s1" }] : [], error });
  const capture: { update?: Record<string, unknown> } = {};
  const chain = {
    update: (payload: Record<string, unknown>) => { capture.update = payload; return chain; },
    eq: () => chain,
    select: () => result,
  };
  return { client: { from: () => chain } as never, capture };
}

describe("freeMaintenanceSlot (VOZ-319)", () => {
  it("frees a maintenance slot: clears lease state and returns true", async () => {
    const { client, capture } = fakeSupabase(true);
    expect(await freeMaintenanceSlot(client, "s1")).toBe(true);
    // The row must come back fully clean — a freed slot keeping a stale
    // assistant/campaign pointer is exactly the cross-wiring the pool guards against.
    expect(capture.update).toMatchObject({
      status: "free",
      current_assistant_id: null,
      current_campaign_id: null,
    });
    expect(capture.update?.released_at).toBeTruthy();
  });

  it("returns false when the guard matches nothing (slot not in maintenance)", async () => {
    const { client } = fakeSupabase(false);
    expect(await freeMaintenanceSlot(client, "s1")).toBe(false);
  });

  it("throws loudly on a DB error instead of reporting a silent false", async () => {
    const { client } = fakeSupabase(false, { message: "connection reset" });
    await expect(freeMaintenanceSlot(client, "s1")).rejects.toThrow(/freeMaintenanceSlot failed/);
  });
});
