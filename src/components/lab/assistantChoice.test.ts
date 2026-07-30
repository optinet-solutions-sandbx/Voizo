import { describe, it, expect } from "vitest";

import { reconcileAssistantId } from "./assistantChoice";

const LAB = [{ id: "2e5e1cdc-lab" }];
const DONOR = "7255c115-c24d-429a-a0d7-8697637a417c";

describe("reconcileAssistantId — VOZ-253 (lab agent vs stale stored id)", () => {
  it("keeps the stored id while the lab still offers it", () => {
    expect(reconcileAssistantId("2e5e1cdc-lab", LAB)).toBe("2e5e1cdc-lab");
  });

  it("snaps off a stale donor id, which is what the routes would 403", () => {
    // lab_settings.lab_assistant_id still names the clone donor from before the
    // split; sending it on Save is the exact 403 this guard prevents.
    expect(reconcileAssistantId(DONOR, LAB)).toBe("2e5e1cdc-lab");
  });

  it("fills an empty selection from the offered agent", () => {
    expect(reconcileAssistantId("", LAB)).toBe("2e5e1cdc-lab");
  });

  it("leaves the selection alone while the list is empty (not loaded, or fetch failed)", () => {
    expect(reconcileAssistantId(DONOR, [])).toBe(DONOR);
  });
});
