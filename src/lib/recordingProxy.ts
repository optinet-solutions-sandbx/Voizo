// Pure helpers for the recordings proxy route (no deps — unit-testable with
// relative imports, importable by the route without dragging env singletons).
//
// Context: Vapi moved recording storage ~2026-07-16. The old public host
// (storage.vapi.ai) is DNS-dead and the new one is PRIVATE Cloudflare R2
// (*.r2.cloudflarestorage.com — unsigned GETs return 400). Stored
// calls_v2.recording_url values are therefore dead links in BOTH generations.
// But every stored URL carries the Vapi call id as the filename's leading UUID
// (2519/2519 rows verified 2026-07-17, 0 mismatches vs the vapi_call_id
// column), and Vapi's GET /call/{id} returns fresh presigned URLs (~30-min
// expiry) for old and new calls alike. So the proxy derives the call id from
// the stored URL and re-resolves a playable link per request.

const LEADING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FULL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A bare Vapi call id, validated (lowercased) or null. Lets callers that
 *  already hold the call id — e.g. the builder run history, whose lab call_id
 *  IS the vapi call id — resolve a recording without a stored recording_url.
 *  Same trust level as the URL path: the id only ever addresses Vapi's own
 *  authenticated API, so SSRF stays bounded to "which call ids can you probe". */
export function normalizeVapiCallId(callId: unknown): string | null {
  return typeof callId === "string" && FULL_UUID.test(callId) ? callId.toLowerCase() : null;
}

/** Vapi call id from a stored recording URL's filename (leading UUID), or null. */
export function vapiCallIdFromRecordingUrl(recordingUrl: unknown): string | null {
  if (typeof recordingUrl !== "string" || recordingUrl === "") return null;
  let basename: string;
  try {
    basename = new URL(recordingUrl).pathname.split("/").pop() ?? "";
  } catch {
    return null; // not a URL at all
  }
  const m = LEADING_UUID.exec(basename);
  return m ? m[0].toLowerCase() : null;
}

/**
 * First playable https URL in a Vapi call artifact. Presigned fields first —
 * the only ones that work against private R2; the raw fields stay as last
 * resorts in case Vapi ever serves public URLs again.
 */
export function pickPlayableUrl(artifact: unknown): string | null {
  if (!artifact || typeof artifact !== "object") return null;
  const a = artifact as Record<string, unknown>;
  const mono = (a.recording as Record<string, unknown> | undefined)?.mono as
    | Record<string, unknown>
    | undefined;
  const candidates = [a.presignedMonoUrl, a.presignedStereoUrl, mono?.combinedUrl, a.recordingUrl];
  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("https://")) return c;
  }
  return null;
}
