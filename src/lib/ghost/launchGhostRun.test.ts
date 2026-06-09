import { describe, it, expect, vi, beforeEach } from "vitest";

// Relative mock paths (vitest does not resolve the "@/" alias).
vi.mock("../vapi/cloneAssistant", () => ({ createClone: vi.fn() }));
vi.mock("../vapi/sipPool", () => ({
  leaseSlotForGhost: vi.fn(),
  patchPhoneAssistant: vi.fn(),
  releaseSlot: vi.fn(),
}));
vi.mock("../campaignV2Data", () => ({ createCampaignV2: vi.fn() }));

import { launchGhostRun } from "./launchGhostRun";
import { createClone } from "../vapi/cloneAssistant";
import { leaseSlotForGhost, patchPhoneAssistant, releaseSlot } from "../vapi/sipPool";
import { createCampaignV2 } from "../campaignV2Data";

const SLOT = { id: "s1", slot_index: 2, sip_uri: "sip:x", sip_username: "u", vapi_phone_number_id: "p1" };

function input(tier: "test" | "live" = "test") {
  return {
    supabase: {} as never,
    vapiPrivateKey: "k",
    reserve: 1,
    run: { id: "r1", name: "Run", tier, base_assistant_id: "base_1", operator: "op@x.com" },
    systemPrompt: "p",
    timezone: "Asia/Manila",
    callWindows: tier === "live" ? [{ day: "mon" as const, start: "12:00", end: "17:00" }] : [],
    numbers: ["+15551112222"],
    smsEnabled: false,
    smsTemplate: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn().mockResolvedValue({ ok: true }) as never;
  // releaseSlot is awaited with .catch() in the rollback paths, so its mock must
  // return a promise (a bare vi.fn() returns undefined → ".catch of undefined").
  (releaseSlot as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe("launchGhostRun", () => {
  it("yields 503 + deletes the clone when the pool is at the reserve floor", async () => {
    (createClone as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, clone: { id: "c1", name: "c" } });
    (leaseSlotForGhost as ReturnType<typeof vi.fn>).mockResolvedValue("reserved");
    const r = await launchGhostRun(input());
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/assistant/c1"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(createCampaignV2).not.toHaveBeenCalled();
  });

  it("materializes with source=ghost_portal + isTest=true for the test tier", async () => {
    (createClone as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, clone: { id: "c1", name: "c" } });
    (leaseSlotForGhost as ReturnType<typeof vi.fn>).mockResolvedValue(SLOT);
    (patchPhoneAssistant as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, body: "" });
    (createCampaignV2 as ReturnType<typeof vi.fn>).mockResolvedValue({ campaign: { id: "camp1" }, numberCount: 1 });
    const r = await launchGhostRun(input("test"));
    expect(r).toMatchObject({ ok: true, campaignId: "camp1", slotIndex: 2, numberCount: 1 });
    expect(createCampaignV2).toHaveBeenCalledWith(
      expect.objectContaining({ source: "ghost_portal", isTest: true, vapiPoolSlotId: "s1", vapiAssistantId: "c1" }),
    );
  });

  it("materializes with isTest=false for the live tier", async () => {
    (createClone as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, clone: { id: "c1", name: "c" } });
    (leaseSlotForGhost as ReturnType<typeof vi.fn>).mockResolvedValue(SLOT);
    (patchPhoneAssistant as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, body: "" });
    (createCampaignV2 as ReturnType<typeof vi.fn>).mockResolvedValue({ campaign: { id: "camp2" }, numberCount: 1 });
    await launchGhostRun(input("live"));
    expect(createCampaignV2).toHaveBeenCalledWith(expect.objectContaining({ source: "ghost_portal", isTest: false }));
  });

  it("returns 502 + releases slot + deletes clone when the phone PATCH fails", async () => {
    (createClone as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, clone: { id: "c1", name: "c" } });
    (leaseSlotForGhost as ReturnType<typeof vi.fn>).mockResolvedValue(SLOT);
    (patchPhoneAssistant as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 500, body: "boom" });
    const r = await launchGhostRun(input());
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(releaseSlot).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(createCampaignV2).not.toHaveBeenCalled();
  });

  it("rolls back (PATCH null + release + delete) and returns 500 when materialization throws", async () => {
    (createClone as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, clone: { id: "c1", name: "c" } });
    (leaseSlotForGhost as ReturnType<typeof vi.fn>).mockResolvedValue(SLOT);
    (patchPhoneAssistant as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200, body: "" });
    (createCampaignV2 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("db down"));
    const r = await launchGhostRun(input());
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(patchPhoneAssistant).toHaveBeenLastCalledWith("k", "p1", null); // detach rollback
    expect(releaseSlot).toHaveBeenCalledWith(expect.anything(), "s1");
  });

  it("deletes the clone + returns 500 when leaseSlotForGhost THROWS (no orphaned billable clone)", async () => {
    // leaseSlotForGhost throws when the free-slot count query fails (sipPool.ts).
    // The clone is already created/billable — it MUST be deleted, not orphaned.
    (createClone as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, clone: { id: "c1", name: "c" } });
    (leaseSlotForGhost as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("free-count failed"));
    const r = await launchGhostRun(input());
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/assistant/c1"),
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(createCampaignV2).not.toHaveBeenCalled();
  });
});
