import { NextRequest, NextResponse } from "next/server";
import { vapiCallIdFromRecordingUrl, normalizeVapiCallId, pickPlayableUrl } from "@/lib/recordingProxy";

/**
 * GET /api/recordings/proxy?url=<stored calls_v2.recording_url>
 *     — or —
 * GET /api/recordings/proxy?callId=<vapi call id>
 *
 * `url` is the original contract (call-detail modal, /reviews, ghost pages,
 * exports); `callId` is for callers that already hold the Vapi call id and have
 * no stored recording_url — the Script Builder run history, whose lab call_id
 * IS the vapi call id (VOZ-197). Both collapse to the same call-id → Vapi
 * presigned-URL → stream path below.
 *
 * Streams a Vapi call recording through Vercel so the browser can play it.
 *
 * Why a proxy at all: Vapi recording storage was never browser-friendly —
 * storage.vapi.ai served bytes publicly but without CORS headers (verified
 * empirically 2026-05-25). Since ~2026-07-16 it's worse: recordings live on
 * PRIVATE Cloudflare R2 (*.r2.cloudflarestorage.com/hipaa-recordings/) where
 * unsigned GETs return 400, and the old host's DNS is gone entirely. Stored
 * recording_url values are dead links in BOTH generations.
 *
 * Why play-time resolution: Vapi's GET /call/{id} returns presigned URLs
 * (artifact.presignedMonoUrl et al) that work for old AND new calls but expire
 * after ~30 minutes — nothing durable can be stored. So this route derives the
 * Vapi call id from the stored URL's filename (leading UUID; 2519/2519 rows
 * verified 2026-07-17) via vapiCallIdFromRecordingUrl, asks Vapi for a fresh
 * presigned link, and streams those bytes same-origin. Consumers (call-detail
 * modal, /reviews, ghost /s pages, audio-zip export) keep their existing
 * ?url=<stored url> contract and heal without changes.
 *
 * Security (surface SHRINKS vs the old prefix-allowlist design):
 *   - The user-supplied `url` is NEVER fetched — it is only parsed for a UUID,
 *     so SSRF collapses to "which of our call ids can you probe".
 *   - The audio URL actually fetched comes exclusively from Vapi's
 *     authenticated API response (same trust level as acting on their
 *     webhooks), https-only, redirect:"error".
 *   - Basic Auth middleware gates the route (caller is a logged-in operator).
 *
 * Cost (CLAUDE.md non-negotiable #4): adds one Vapi metadata GET per
 * play/download (no per-request charge, ~200ms). Audio egress unchanged
 * (~1-3 MB each; a 500-call export ≈ 1.5 GB — fine on Pro's 1 TB/mo). Zero
 * call-path / SMS impact.
 */

// Two upstream hops now (Vapi API ~10s cap + audio stream ~30s cap); the old
// single-hop route relied on the platform default. Declare headroom explicitly
// so large audio files can't be cut off mid-stream.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const urlParam = params.get("url");
  const callIdParam = params.get("callId");
  if (!urlParam && !callIdParam) {
    return NextResponse.json({ error: "Missing url or callId parameter" }, { status: 400 });
  }

  // callId (validated) wins; otherwise derive the id from the stored URL.
  const callId = normalizeVapiCallId(callIdParam) ?? vapiCallIdFromRecordingUrl(urlParam);
  if (!callId) {
    return NextResponse.json(
      { error: "Provide a valid callId, or a recognizable Vapi recording URL" },
      { status: 400 },
    );
  }

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[recordings/proxy] VAPI_PRIVATE_KEY not set — cannot resolve recordings");
    return NextResponse.json({ error: "Recording resolution not configured" }, { status: 502 });
  }

  // ── 1. Fresh presigned URL from Vapi (stored URLs are dead — see header) ──
  let call: Response;
  try {
    call = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${vapiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Vapi API fetch failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
  if (call.status === 404) {
    return NextResponse.json({ error: "Call not found on Vapi" }, { status: 404 });
  }
  if (!call.ok) {
    return NextResponse.json({ error: `Vapi API returned ${call.status}` }, { status: 502 });
  }

  let artifact: unknown;
  try {
    artifact = ((await call.json()) as Record<string, unknown>).artifact;
  } catch {
    return NextResponse.json({ error: "Vapi API returned malformed JSON" }, { status: 502 });
  }

  const playable = pickPlayableUrl(artifact);
  if (!playable) {
    return NextResponse.json({ error: "No recording available for this call" }, { status: 404 });
  }

  // ── 2. Stream the audio (same response contract as the pre-migration proxy) ──
  // redirect:"error" — presigned S3-style GETs don't redirect; refuse surprises
  // rather than follow them somewhere the resolution step didn't vouch for.
  let upstream: Response;
  try {
    upstream = await fetch(playable, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Upstream fetch failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    // 400/401/403/404 from storage = the link class is dead (unsigned/expired/
    // gone), not a transient fault — surface the clean "not available" instead
    // of a misleading 502 (review finding 2026-07-17). 5xx stays 502.
    const gone = upstream.status >= 400 && upstream.status < 500;
    return NextResponse.json(
      {
        error: gone
          ? "Recording no longer available from Vapi"
          : `Upstream returned ${upstream.status}`,
      },
      { status: gone ? 404 : 502 },
    );
  }

  const responseHeaders: HeadersInit = {
    "Content-Type": upstream.headers.get("content-type") ?? "audio/wav",
  };
  const contentLength = upstream.headers.get("content-length");
  if (contentLength) responseHeaders["Content-Length"] = contentLength;

  return new Response(upstream.body, {
    status: 200,
    headers: responseHeaders,
  });
}
