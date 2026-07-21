// Customer.io webhook signature verification (VOZ-180 — docs/2026-07-21_SPEC_CustomerIO_Webhook_Ingress.md §5.1).
//
// Customer.io signs every "Send and receive data" webhook action request:
//   X-CIO-Signature = hex( HMAC-SHA256( signingKey, `v0:<X-CIO-Timestamp>:<raw body>` ) )
// Signing keys live per workspace (Settings → API & Webhook Credentials →
// Webhook signing keys). We hold them as a JSON map in the
// CUSTOMERIO_WEBHOOK_SIGNING_KEYS env var — one entry today, 10+ later
// (spec §8): `{"lucky7even":"<key>", ...}`. Verification tries each key and
// names the workspace that matched, so multi-tenant routing needs no code
// change when a workspace is added.
//
// Pure module (crypto only, no I/O) so vitest locks the contract without env.
// Relative-import friendly per the house testable-route convention.

import { createHmac, timingSafeEqual } from "crypto";

/** Replay window: reject timestamps further than this from our clock. */
const DEFAULT_MAX_SKEW_SECONDS = 5 * 60;

export interface CioVerifyResult {
  ok: boolean;
  /** Which key map entry matched (null when ok=false). */
  workspace: string | null;
}

/**
 * Parse CUSTOMERIO_WEBHOOK_SIGNING_KEYS. Anything but a JSON object of
 * string→string collapses to {} — a misconfigured env must fail CLOSED
 * (every request rejected), never throw at import time.
 */
export function parseSigningKeys(envValue: string | undefined): Record<string, string> {
  if (!envValue) return {};
  try {
    const parsed: unknown = JSON.parse(envValue);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Verify an incoming request against every known workspace key.
 * Never throws — malformed headers are just a failed verification.
 */
export function verifyCioSignature(args: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  keys: Record<string, string>;
  nowMs: number;
  maxSkewSeconds?: number;
}): CioVerifyResult {
  const { rawBody, timestampHeader, signatureHeader, keys, nowMs } = args;
  const maxSkew = args.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;

  if (!timestampHeader || !signatureHeader) return { ok: false, workspace: null };

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, workspace: null };
  if (Math.abs(nowMs / 1000 - ts) > maxSkew) return { ok: false, workspace: null };

  // Buffer.from(_, "hex") never throws — malformed hex just yields a short
  // buffer, which the length check below rejects.
  const received = Buffer.from(signatureHeader.toLowerCase(), "hex");

  for (const [workspace, key] of Object.entries(keys)) {
    // Sign over the RAW header string — that's what Customer.io signed.
    // (`ts` above is only for the skew check.)
    const expected = createHmac("sha256", key).update(`v0:${timestampHeader}:${rawBody}`).digest();
    // timingSafeEqual throws on length mismatch — guard first. The length
    // check itself leaks nothing useful (digest length is public knowledge).
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      return { ok: true, workspace };
    }
  }
  return { ok: false, workspace: null };
}
