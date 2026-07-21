import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { parseSigningKeys, verifyCioSignature } from "./customerioWebhookAuth";

/** Signs the way Customer.io does: HMAC-SHA256 over `v0:<ts>:<body>`, hex. */
function sign(key: string, tsSeconds: number, body: string): string {
  return createHmac("sha256", key).update(`v0:${tsSeconds}:${body}`).digest("hex");
}

const KEYS = { lucky7even: "test-signing-key-A", rooster: "test-signing-key-B" };
const NOW_MS = 1_800_000_000_000; // fixed clock for determinism
const NOW_S = Math.floor(NOW_MS / 1000);
const BODY = '{"cio_id":"c1","phone":"+61412345678","segment_id":42}';

describe("verifyCioSignature", () => {
  it("accepts a valid signature and names the matching workspace", () => {
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: String(NOW_S),
      signatureHeader: sign(KEYS.lucky7even, NOW_S, BODY),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res).toEqual({ ok: true, workspace: "lucky7even" });
  });

  it("resolves the SECOND workspace's key too (multi-key map)", () => {
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: String(NOW_S),
      signatureHeader: sign(KEYS.rooster, NOW_S, BODY),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res).toEqual({ ok: true, workspace: "rooster" });
  });

  it("rejects a tampered body", () => {
    const res = verifyCioSignature({
      rawBody: BODY.replace("+61412345678", "+15550001111"),
      timestampHeader: String(NOW_S),
      signatureHeader: sign(KEYS.lucky7even, NOW_S, BODY),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a signature made with an unknown key", () => {
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: String(NOW_S),
      signatureHeader: sign("some-other-key", NOW_S, BODY),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a stale timestamp (replay protection, default 5 min)", () => {
    const staleTs = NOW_S - 6 * 60;
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: String(staleTs),
      signatureHeader: sign(KEYS.lucky7even, staleTs, BODY),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res.ok).toBe(false);
  });

  it("accepts small clock skew inside the window", () => {
    const recentTs = NOW_S - 2 * 60;
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: String(recentTs),
      signatureHeader: sign(KEYS.lucky7even, recentTs, BODY),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res.ok).toBe(true);
  });

  it("verifies over the RAW timestamp header string, not its numeric re-encoding", () => {
    const rawTs = `0${NOW_S}`; // leading zero — Number() re-encodes it differently
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: rawTs,
      signatureHeader: createHmac("sha256", KEYS.lucky7even).update(`v0:${rawTs}:${BODY}`).digest("hex"),
      keys: KEYS,
      nowMs: NOW_MS,
    });
    expect(res).toEqual({ ok: true, workspace: "lucky7even" });
  });

  it("never throws on garbage headers (missing / non-numeric / wrong length)", () => {
    for (const [ts, sig] of [
      [null, null],
      ["not-a-number", "zz"],
      [String(NOW_S), "deadbeef"], // wrong-length hex
      [String(NOW_S), ""],
    ] as const) {
      expect(
        verifyCioSignature({
          rawBody: BODY,
          timestampHeader: ts,
          signatureHeader: sig,
          keys: KEYS,
          nowMs: NOW_MS,
        }).ok,
      ).toBe(false);
    }
  });

  it("rejects everything when the key map is empty", () => {
    const res = verifyCioSignature({
      rawBody: BODY,
      timestampHeader: String(NOW_S),
      signatureHeader: sign(KEYS.lucky7even, NOW_S, BODY),
      keys: {},
      nowMs: NOW_MS,
    });
    expect(res.ok).toBe(false);
  });
});

describe("parseSigningKeys", () => {
  it("parses a JSON map of workspace → key", () => {
    expect(parseSigningKeys('{"lucky7even":"abc","rooster":"def"}')).toEqual({
      lucky7even: "abc",
      rooster: "def",
    });
  });

  it("returns {} on unset / malformed / non-object env values", () => {
    expect(parseSigningKeys(undefined)).toEqual({});
    expect(parseSigningKeys("")).toEqual({});
    expect(parseSigningKeys("not-json")).toEqual({});
    expect(parseSigningKeys('["a"]')).toEqual({});
    expect(parseSigningKeys('"bare-string"')).toEqual({});
  });

  it("drops non-string values instead of trusting them", () => {
    expect(parseSigningKeys('{"a":"ok","b":123,"c":null}')).toEqual({ a: "ok" });
  });
});
