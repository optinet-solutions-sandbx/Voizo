import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CIO_DEFAULT_WORKSPACE, lookupLadder, resolveAppApiKey } from "./customerio";

// VOZ-185: identifier forms empirically verified against the live EU App API
// (2026-07-22): the legacy `cio_<cio_id>` prefix form and raw-email form 404;
// bare cio_id and email resolve only with an explicit id_type. Leg 1
// (workspace id, no id_type) is untouched — prod-proven for months.
describe("lookupLadder (VOZ-185 identifier fallback)", () => {
  const member = { id: "lucky7even:158491", cio_id: "a2f707098dcf01be8c12", email: "p@x.com" };

  it("full member → id (no id_type), then BARE cio_id + id_type, then email + id_type", () => {
    expect(lookupLadder(member)).toEqual([
      { identifier: "lucky7even:158491" },
      { identifier: "a2f707098dcf01be8c12", idType: "cio_id" },
      { identifier: "p@x.com", idType: "email" },
    ]);
  });

  it("id-less member (the 07-22 trial profile shape) → cio_id leg leads, NO cio_ prefix", () => {
    const ladder = lookupLadder({ cio_id: "a2f707098dcf01be8c12", email: "p@x.com" });
    expect(ladder).toEqual([
      { identifier: "a2f707098dcf01be8c12", idType: "cio_id" },
      { identifier: "p@x.com", idType: "email" },
    ]);
    // The regression that made legs 2/3 dead: the prefix form must never return.
    expect(ladder.some((l) => l.identifier.startsWith("cio_"))).toBe(false);
  });

  it("blank/whitespace identifiers are filtered", () => {
    expect(lookupLadder({ id: "  ", cio_id: "", email: "p@x.com" })).toEqual([
      { identifier: "p@x.com", idType: "email" },
    ]);
  });

  it("member with no usable identifiers → empty ladder (caller reports failure)", () => {
    expect(lookupLadder({ cio_id: "" })).toEqual([]);
  });
});

// VOZ-198: per-workspace App API keys (Fortune Play = workspace #2). The map
// env CUSTOMERIO_APP_API_KEYS mirrors CUSTOMERIO_WEBHOOK_SIGNING_KEYS'
// {workspace label → key} shape; the legacy single CUSTOMERIO_APP_API_KEY
// stays as the fallback for the default workspace ONLY, so prod behaves
// identically until a second workspace is configured.
describe("resolveAppApiKey (VOZ-198 multi-workspace)", () => {
  const savedSingle = process.env.CUSTOMERIO_APP_API_KEY;
  const savedMap = process.env.CUSTOMERIO_APP_API_KEYS;

  beforeEach(() => {
    delete process.env.CUSTOMERIO_APP_API_KEY;
    delete process.env.CUSTOMERIO_APP_API_KEYS;
  });
  afterEach(() => {
    if (savedSingle === undefined) delete process.env.CUSTOMERIO_APP_API_KEY;
    else process.env.CUSTOMERIO_APP_API_KEY = savedSingle;
    if (savedMap === undefined) delete process.env.CUSTOMERIO_APP_API_KEYS;
    else process.env.CUSTOMERIO_APP_API_KEYS = savedMap;
  });

  it("default workspace falls back to the legacy single key when no map exists", () => {
    process.env.CUSTOMERIO_APP_API_KEY = "legacy-key";
    expect(resolveAppApiKey()).toEqual({ key: "legacy-key", error: null });
    expect(resolveAppApiKey(CIO_DEFAULT_WORKSPACE)).toEqual({ key: "legacy-key", error: null });
  });

  it("null / blank workspace mean the default workspace (campaign rows pass cio_workspace straight through)", () => {
    process.env.CUSTOMERIO_APP_API_KEY = "legacy-key";
    expect(resolveAppApiKey(null)).toEqual({ key: "legacy-key", error: null });
    expect(resolveAppApiKey("  ")).toEqual({ key: "legacy-key", error: null });
  });

  it("default workspace prefers its map entry over the legacy key", () => {
    process.env.CUSTOMERIO_APP_API_KEY = "legacy-key";
    process.env.CUSTOMERIO_APP_API_KEYS = JSON.stringify({ lucky7even: "map-key" });
    expect(resolveAppApiKey()).toEqual({ key: "map-key", error: null });
  });

  it("a second workspace resolves from its map entry", () => {
    process.env.CUSTOMERIO_APP_API_KEYS = JSON.stringify({ lucky7even: "l7", fortuneplay: "fp-key" });
    expect(resolveAppApiKey("fortuneplay")).toEqual({ key: "fp-key", error: null });
  });

  it("a second workspace NEVER falls back to the legacy key (fail closed — the cross-brand guard)", () => {
    process.env.CUSTOMERIO_APP_API_KEY = "legacy-key";
    const res = resolveAppApiKey("fortuneplay");
    expect(res.key).toBeNull();
    expect(res.error).toContain("fortuneplay");
    expect(res.error).toContain("CUSTOMERIO_APP_API_KEYS");
  });

  it("a map entry that is empty/non-string counts as missing", () => {
    process.env.CUSTOMERIO_APP_API_KEYS = JSON.stringify({ fortuneplay: "" });
    expect(resolveAppApiKey("fortuneplay").key).toBeNull();
    process.env.CUSTOMERIO_APP_API_KEYS = JSON.stringify({ fortuneplay: 42 });
    expect(resolveAppApiKey("fortuneplay").key).toBeNull();
  });

  it("malformed map JSON: default workspace still reaches the legacy key, others fail closed", () => {
    process.env.CUSTOMERIO_APP_API_KEY = "legacy-key";
    process.env.CUSTOMERIO_APP_API_KEYS = "{not json";
    expect(resolveAppApiKey()).toEqual({ key: "legacy-key", error: null });
    expect(resolveAppApiKey("fortuneplay").key).toBeNull();
  });

  it("no key anywhere → the pre-existing error message for the default workspace (route 500-sniff contract)", () => {
    const res = resolveAppApiKey();
    expect(res.key).toBeNull();
    expect(res.error).toContain("CUSTOMERIO_APP_API_KEY");
  });
});
