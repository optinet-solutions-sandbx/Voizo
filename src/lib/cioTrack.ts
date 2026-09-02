// Customer.io Track API client (email follow-up channel, 2026-09-01 plan).
//
// This is the THIRD Customer.io credential and the only one that can send events:
//   App API (Bearer)        — CUSTOMERIO_APP_API_KEYS   — read/query, CANNOT send events
//   Webhook signing (HMAC)  — CUSTOMERIO_WEBHOOK_SIGNING_KEYS — inbound only
//   Track API (HTTP basic)  — CUSTOMERIO_TRACK_API_KEYS — THIS ONE. "SITEID:APIKEY" per workspace.
// The confusion between the first and third is exactly how this channel was almost pointed at a
// key that cannot work, so the shapes are validated hard here.
//
// Pure module: no I/O at import time, no singletons, never throws. A broken or missing credential
// fails CLOSED (resolveTrackCredential returns null → the caller sends nothing) — the feature is
// dormant, not crashing, until the env var lands.
//
// ⚠️⚠️ CREDENTIAL VERIFICATION — READ BEFORE TRUSTING ANY "the keys are fine" CLAIM (2026-09-02).
// This file used to say all three pairs were "verified live: 200 from GET /auth". That was FALSE.
// `GET https://track-eu.customer.io/auth` is a MARKETING PAGE: it returns 200 for any credentials,
// including complete garbage (proven with a known-bad control). The roosterbet pair shipped
// unverified behind that non-check and 401'd on its first real event in production.
//
// The endpoint that actually discriminates:
//     GET https://track-eu.customer.io/api/v1/accounts/region     (HTTP basic, siteId:apiKey)
//       garbage    -> 401 {"meta":{"error":"Unauthorized request"}}
//       valid pair -> 200 {"region":"eu","environment_id":<WORKSPACE ID>,...}
// `environment_id` is the workspace id, so one call proves the pair is real AND that it belongs to
// the workspace we meant — which is the only defence against the four Rooster lookalikes, where
// picking the wrong one otherwise fails silently. Expected ids: lucky7even 129954,
// fortuneplay 154941, roosterbet 142595. Run scripts/_verify-0901-track-keys.cjs.
//
// Related: a valid key addressing a cio_id from ANOTHER workspace returns 400 "invalid identifier",
// never 401 — so a 401 from an event POST is always about the credential itself, never the person.

/** EU region — the account is EU (CUSTOMERIO_API_REGION=eu); the US host would 401 every key. */
export const TRACK_HOST = "track-eu.customer.io";

/** Never sent in event data, even if a caller passes them (Q1: CIO already knows the person). */
const BANNED_DATA_FIELDS = new Set(["phone", "phone_e164", "name", "email", "first_name", "display_name"]);

export interface TrackCredential {
  siteId: string;
  apiKey: string;
}

/**
 * Resolve one workspace's Track credential from the CUSTOMERIO_TRACK_API_KEYS env value
 * (JSON map workspace → "SITEID:APIKEY"). Anything malformed — missing env, bad JSON, unknown
 * workspace, missing colon, empty half — returns null. Split on the FIRST colon only: a site id
 * never contains one, an API key might.
 */
export function resolveTrackCredential(envValue: string | undefined, workspace: string): TrackCredential | null {
  if (!envValue) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = (parsed as Record<string, unknown>)[workspace];
  if (typeof raw !== "string") return null;
  const i = raw.indexOf(":");
  if (i <= 0 || i === raw.length - 1) return null;
  return { siteId: raw.slice(0, i), apiKey: raw.slice(i + 1) };
}

export type TrackSendResult = { ok: true } | { ok: false; status?: number; error: string };

/**
 * Fire one custom event at a Customer.io person, addressed by cio_id.
 *
 * Endpoint: POST /api/v1/customers/cio_<cio_id>/events (the documented cio_ prefix form for
 * addressing by cio_id on the Track API). ⚠ Unverified against a live event until the first
 * controlled test — if CIO rejects the prefix form, the fallback is the Track v2 /api/v2/entity
 * shape; the controlled test is designed to catch this on day one.
 *
 * Failure contract: NEVER throws. Network death, abort, non-2xx — all collapse to {ok:false}.
 * The caller records the failure on the ledger row; a follow-up email must never be able to
 * break the end-of-call webhook that carries live call handling.
 */
export async function sendTrackEvent(args: {
  credential: TrackCredential;
  cioId: string;
  eventName: string;
  data: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<TrackSendResult> {
  // Strip banned fields no matter who calls us — defence in depth for the payload rule.
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.data)) {
    if (!BANNED_DATA_FIELDS.has(k.toLowerCase())) data[k] = v;
  }

  const url = `https://${TRACK_HOST}/api/v1/customers/cio_${encodeURIComponent(args.cioId)}/events`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${args.credential.siteId}:${args.credential.apiKey}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: args.eventName, data }),
      // Explicit timeout: customerioFetch shipped without one and a hung CIO held the caller
      // open (VOZ-425). This runs inside the end-of-call webhook — it must always come back.
      signal: AbortSignal.timeout(args.timeoutMs ?? 5000),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: `Track API ${res.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
