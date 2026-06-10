import { describe, it, expect } from "vitest";
import { disguiseIfGhost, GHOST_MAINTENANCE } from "./workerDisguise";

const leasedSlot = {
  slotIndex: 0,
  slotLabel: "voizo-sip-pool-slot-00",
  status: "leased",
  sipUri: "sip:x",
  leasedAt: "2026-06-09T00:00:00Z",
  leasedDurationMs: 12345,
  campaign: { id: "g", name: "Ghost Run", status: "running", timezone: "UTC", vapiAssistantName: "clone" },
  inFlightCall: { callId: "k", phoneE164: "+15551110000" },
  notes: "note",
};

describe("disguiseIfGhost", () => {
  it("rewrites a ghost-leased slot to maintenance + strips ALL lease detail", () => {
    const out = disguiseIfGhost(leasedSlot, "ghost_portal");
    expect(out.status).toBe(GHOST_MAINTENANCE);
    expect(out.campaign).toBeNull();
    expect(out.inFlightCall).toBeNull();
    expect(out.leasedAt).toBeNull();
    expect(out.leasedDurationMs).toBeNull();
    expect(out.notes).toBeNull();
    // Slot identity is fine to keep — it's the LEASE that leaks.
    expect(out.slotIndex).toBe(0);
    expect(out.sipUri).toBe("sip:x");
  });

  it("leaves a production-leased slot untouched", () => {
    expect(disguiseIfGhost(leasedSlot, "production")).toEqual(leasedSlot);
  });

  it("leaves a slot untouched when source is null/undefined (free / legacy)", () => {
    expect(disguiseIfGhost(leasedSlot, null)).toEqual(leasedSlot);
    expect(disguiseIfGhost(leasedSlot, undefined)).toEqual(leasedSlot);
  });
});
