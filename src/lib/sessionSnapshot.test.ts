import { describe, it, expect, vi, afterEach } from "vitest";
import { loadSnapshot, saveSnapshot } from "./sessionSnapshot";

// Node test env has no sessionStorage — a Map-backed fake per test. The contract
// under test: NEVER throw; every failure path degrades to null / a warning.

function stubSessionStorage(opts: { throwOnSet?: boolean } = {}) {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe("sessionSnapshot", () => {
  it("round-trips a value under the prefixed key", () => {
    const store = stubSessionStorage();
    saveSnapshot("dashboard.today", { ops: { callsToday: 7 } });
    expect(loadSnapshot("dashboard.today")).toEqual({ ops: { callsToday: 7 } });
    expect([...store.keys()]).toEqual(["voizo.snap.v1:dashboard.today"]);
  });

  it("returns null when absent or corrupt", () => {
    const store = stubSessionStorage();
    expect(loadSnapshot("nope")).toBeNull();
    store.set("voizo.snap.v1:bad", "{not json");
    expect(loadSnapshot("bad")).toBeNull();
  });

  it("returns null when sessionStorage is unavailable (SSR/disabled)", () => {
    expect(loadSnapshot("anything")).toBeNull();
  });

  it("save never throws — quota degrades to a warning", () => {
    stubSessionStorage({ throwOnSet: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => saveSnapshot("k", {})).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
