import { describe, it, expect } from "vitest";
import { toggleKey } from "./toggleSet";

describe("toggleKey (interactive chart legend show/hide)", () => {
  it("adds a key that isn't present", () => {
    expect([...toggleKey(new Set<string>(), "a")]).toEqual(["a"]);
  });

  it("removes a key that is present", () => {
    expect([...toggleKey(new Set(["a", "b"]), "a")]).toEqual(["b"]);
  });

  it("returns a NEW set and never mutates the input (React state safety)", () => {
    const input = new Set(["a"]);
    const out = toggleKey(input, "b");
    expect(out).not.toBe(input);
    expect([...input]).toEqual(["a"]); // input untouched
    expect([...out].sort()).toEqual(["a", "b"]);
  });
});
