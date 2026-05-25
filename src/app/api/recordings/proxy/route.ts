import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/recordings/proxy?url=<vapi-storage-url>
 *
 * Streams a Vapi recording through Vercel so the browser can fetch the bytes.
 *
 * Why: Vapi's storage.vapi.ai serves recordings publicly but does NOT send
 * Access-Control-Allow-Origin headers, so browser fetch from the dashboard
 * is blocked by CORS. Verified empirically 2026-05-25 (see memory
 * vapi-recording-behavior). This proxy makes the audio same-origin to the
 * dashboard so JSZip-style bulk exports can read the bytes.
 *
 * Security:
 *   - SSRF allowlist: only https://storage.vapi.ai/* URLs accepted.
 *     Hard-coded prefix match, no user-controlled host.
 *   - Basic Auth middleware applies (caller must be a logged-in operator).
 *   - Response is same-origin to the dashboard, so no extra CORS headers
 *     needed for client-side fetch().
 *
 * Cost (CLAUDE.md non-negotiable #4): each fetched audio is ~1-3 MB. A
 * 500-call export ~ 1.5 GB Vercel egress. Pro tier 1TB/mo — fine for PoC.
 */
const VAPI_STORAGE_PREFIX = "https://storage.vapi.ai/";

export async function GET(request: NextRequest) {
  const urlParam = new URL(request.url).searchParams.get("url");
  if (!urlParam) {
    return NextResponse.json({ error: "Missing url parameter" }, { status: 400 });
  }

  // SSRF guard: only Vapi's recording storage host is reachable through this
  // proxy. Any other URL is rejected before any network call is made.
  if (!urlParam.startsWith(VAPI_STORAGE_PREFIX)) {
    return NextResponse.json(
      { error: "url must be a Vapi storage URL" },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(urlParam);
  } catch (err) {
    return NextResponse.json(
      { error: `Upstream fetch failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    return NextResponse.json(
      { error: `Upstream returned ${upstream.status}` },
      { status: upstream.status === 404 ? 404 : 502 },
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
