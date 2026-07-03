import { describe, it, expect, vi } from "vitest";
import { claimDrawer, onDrawerClaim } from "./drawerExclusivity";

// Cross-section drawer exclusivity (mockup openDrawer: opening one of the three stat-card
// drawers closes the other two). Pure emitter — the React wiring lives in useDrawerClaim.

describe("drawerExclusivity — claim/notify emitter", () => {
  it("notifies every subscriber with the claiming owner's id", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onDrawerClaim(a);
    const offB = onDrawerClaim(b);
    claimDrawer("today");
    expect(a).toHaveBeenCalledWith("today");
    expect(b).toHaveBeenCalledWith("today");
    offA();
    offB();
  });

  it("unsubscribe stops further notifications", () => {
    const cb = vi.fn();
    const off = onDrawerClaim(cb);
    claimDrawer("global");
    off();
    claimDrawer("top-performers");
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("global");
  });

  it("claim with no subscribers is a no-op (never throws)", () => {
    expect(() => claimDrawer("today")).not.toThrow();
  });

  it("a subscriber unsubscribing during dispatch does not break the others", () => {
    const calls: string[] = [];
    const offSelf = onDrawerClaim(() => {
      calls.push("self");
      offSelf(); // self-removal mid-dispatch
    });
    const offOther = onDrawerClaim(() => calls.push("other"));
    claimDrawer("global");
    expect(calls).toEqual(["self", "other"]);
    offOther();
  });
});
