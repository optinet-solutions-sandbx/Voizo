import { describe, it, expect } from "vitest";
import { leaseSlotForGhost } from "./sipPool";

// fakeSupabase serves BOTH the free-slot count query (.from().select().eq())
// and the lease RPC (.rpc()). We do NOT spy on leaseSlot — in ESM the internal
// call is a direct binding the spy can't intercept; instead we exercise the
// real delegation path through the fake RPC.
function fakeSupabase(freeCount: number, slot: Record<string, unknown> | null = null) {
  return {
    from: () => ({ select: () => ({ eq: () => Promise.resolve({ count: freeCount, error: null }) }) }),
    rpc: () => Promise.resolve({ data: slot ? [slot] : [], error: null }),
  } as never;
}

const SLOT = { id: "s1", slot_index: 0, sip_uri: "sip:x", sip_username: "u", vapi_phone_number_id: "p1" };

describe("leaseSlotForGhost", () => {
  it("yields 'reserved' when free <= reserve (production priority)", async () => {
    expect(await leaseSlotForGhost(fakeSupabase(1, SLOT), "asst_1", 1)).toBe("reserved");
  });

  it("leases (delegates to leaseSlot) when free > reserve", async () => {
    expect(await leaseSlotForGhost(fakeSupabase(3, SLOT), "asst_1", 1)).toEqual(SLOT);
  });

  it("returns null when free > reserve but the pool RPC finds no slot", async () => {
    expect(await leaseSlotForGhost(fakeSupabase(3, null), "asst_1", 1)).toBeNull();
  });

  it("reserve=0 allows leasing down to the last slot", async () => {
    expect(await leaseSlotForGhost(fakeSupabase(1, SLOT), "asst_1", 0)).toEqual(SLOT);
  });
});
