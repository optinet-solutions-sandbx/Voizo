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
 *   +64 New Zealand       → FREESWITCH_CALLER_ID_NZ   (pending provisioning)
 *
 * Anything else — or a mapped country whose env var is absent — falls back to
 * the default FREESWITCH_CALLER_ID (an owned number; set it to the CA DID once
 * the UK ANI is retired). Fallback beats refusing to dial: every configured
 * number is ours, so a non-local ANI is legitimate, just lower answer-rate.
 *
 * Env is read at CALL time (test-steerable; mirrors resolveSmsSenderId).
 * Relative import: tested lib modules must resolve without the "@/" alias.
 */

import { detectCountry } from "../audienceCountry";

const COUNTRY_TO_CID_ENV: Record<string, string> = {
  NA: "FREESWITCH_CALLER_ID_CA", // +1 bucket — US/CA indistinguishable by prefix; the CA DID serves both
  AU: "FREESWITCH_CALLER_ID_AU",
  NZ: "FREESWITCH_CALLER_ID_NZ",
};

/** Caller ID to present when dialing `destE164`. Throws when nothing is configured. */
export function resolveFreeswitchCallerId(destE164: string): string {
  const country = detectCountry(destE164);
  const envKey = country ? COUNTRY_TO_CID_ENV[country] : undefined;

  if (envKey) {
    const specific = process.env[envKey]?.trim();
    if (specific) return specific;
    // Mapped country but its env is missing — fall back, loudly (a silent
    // fallback here is how the wrong-ANI bug hides again).
    console.warn(
      `[freeswitch.callerId] ${envKey} not set for ${country} destination — falling back to FREESWITCH_CALLER_ID`,
    );
  }

  const fallback = process.env.FREESWITCH_CALLER_ID?.trim();
  if (!fallback) {
    throw new Error("FREESWITCH_CALLER_ID not set. Required for outbound dialing.");
  }
  return fallback;
}
