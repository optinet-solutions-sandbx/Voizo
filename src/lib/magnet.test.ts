import { describe, it, expect } from "vitest";
import { magnetOffset } from "./magnet";

// rect centered at (50,50) for easy reasoning.
const RECT = { left: 0, top: 0, width: 100, height: 100 };

describe("magnetOffset", () => {
  it("returns zero offset when the pointer is dead-center", () => {
    expect(magnetOffset(RECT, 50, 50)).toEqual({ x: 0, y: 0 });
  });

  it("pulls toward the pointer (right + below center → positive x/y)", () => {
    const o = magnetOffset(RECT, 60, 70);
    expect(o.x).toBeGreaterThan(0);
    expect(o.y).toBeGreaterThan(0);
  });

  it("pulls toward the pointer (left + above center → negative x/y)", () => {
    const o = magnetOffset(RECT, 40, 30);
    expect(o.x).toBeLessThan(0);
    expect(o.y).toBeLessThan(0);
  });

  it("scales the distance by strength (default 0.3)", () => {
    // 10px right of center * 0.3 = 3px, well under the default clamp.
    expect(magnetOffset(RECT, 60, 50)).toEqual({ x: 3, y: 0 });
  });

  it("clamps to max (default 14) for far pointers", () => {
    // 150px right of center * 0.3 = 45 → clamped to 14.
    expect(magnetOffset(RECT, 200, 50)).toEqual({ x: 14, y: 0 });
    expect(magnetOffset(RECT, -200, 50)).toEqual({ x: -14, y: 0 });
  });

  it("honors custom strength and max", () => {
    expect(magnetOffset(RECT, 60, 50, { strength: 0.5, max: 20 })).toEqual({ x: 5, y: 0 });
    expect(magnetOffset(RECT, 300, 50, { strength: 0.5, max: 20 })).toEqual({ x: 20, y: 0 });
  });
});
