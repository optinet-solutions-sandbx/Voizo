/**
 * Per-country outbound caller ID (2026-07-31).
 *
 * Deprecates the shared UK ANI (+442036953434): that number belongs to
 * SquareTalk, not Voizo (Tsvetomira, 2026-07-31), and per-ANI carrier spam
 * flagging makes one number dialing every country a reliability risk — in AU
 * a flagged number stops completing calls at all (SquareTalk AM, 2026-07-31).
 *
 * The destination's country (detectCountry longest-prefix match) picks the
 * owned local DID via env:
 *
 *   +1 (NA bucket, US+CA) → FREESWITCH_CALLER_ID_CA   (+16472436283, Toronto)
 *   +61 Australia         → FREESWITCH_CALLER_ID_AU   (+61272680150, Sydney)
 *   +64 New Zealand       → FREESWITCH_CALLER_ID_NZ   (+6498026124, Auckland)
 *
 * Anything else — or a mapped country whose env var is absent — falls back to
 * the default FREESWITCH_CALLER_ID (an owned number). Fallback beats refusing
 * to dial: every configured number is ours, so a non-local ANI is legitimate,
 * just lower answer-rate.
 *
 * Env is read at CALL time (test-steerable). Relative import: tested lib
 * modules must resolve without the "@/" alias.
 */

import { detectCountry } from "../audienceCountry";

const COUNTRY_TO_CID_ENV: Record<string, string> = {
  NA: "FREESWITCH_CALLER_ID_CA", // +1 bucket — US/CA indistinguishable by prefix; the CA DID serves both
  AU: "FREESWITCH_CALLER_ID_AU",
  NZ: "FREESWITCH_CALLER_ID_NZ",
};

/**
 * Country → caller ID. The core the dialer and the wizard preview share, so
 * neither can drift from the other. Never throws: returns {callerId:null,error}
 * when nothing is configured (the dialer wrapper below turns that into a throw).
 */
export function callerIdForCountry(
  country: string | null,
): { callerId: string; error: null } | { callerId: null; error: string } {
  const envKey = country ? COUNTRY_TO_CID_ENV[country] : undefined;
  if (envKey) {
    const specific = process.env[envKey]?.trim();
    if (specific) return { callerId: specific, error: null };
    // Mapped country but its env is missing — fall back, loudly (a silent
    // fallback is how the wrong-ANI bug hides again).
    console.warn(
      `[freeswitch.callerId] ${envKey} not set for ${country} destination — falling back to FREESWITCH_CALLER_ID`,
    );
  }
  const fallback = process.env.FREESWITCH_CALLER_ID?.trim();
  if (fallback) return { callerId: fallback, error: null };
  return { callerId: null, error: "FREESWITCH_CALLER_ID not set. Required for outbound dialing." };
}

/** Caller ID to present when dialing `destE164`. Throws when nothing is configured. */
export function resolveFreeswitchCallerId(destE164: string): string {
  const r = callerIdForCountry(detectCountry(destE164));
  if (r.callerId === null) throw new Error(r.error); // === null cleanly discriminates the union
  return r.callerId;
}

/**
 * Dedicated local caller IDs by country (null where unprovisioned) plus the
 * default fallback — the wizard identity preview's source. Values are the
 * actual numbers the dialer presents; non-secret (shown to customers).
 * `byCountry[C] == null` means "no local C number yet → falls back".
 */
export function buildCallerIdMap(): { byCountry: Record<string, string | null>; fallback: string | null } {
  const byCountry: Record<string, string | null> = {};
  for (const [country, envKey] of Object.entries(COUNTRY_TO_CID_ENV)) {
    const v = process.env[envKey]?.trim();
    byCountry[country] = v && v.length > 0 ? v : null;
  }
  const fb = process.env.FREESWITCH_CALLER_ID?.trim();
  return { byCountry, fallback: fb && fb.length > 0 ? fb : null };
}
