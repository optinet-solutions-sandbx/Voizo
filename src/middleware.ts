import { NextRequest, NextResponse } from "next/server";

/**
 * HTTP Basic Auth middleware — locks down the entire deployment behind a
 * single username/password from env vars (DASHBOARD_USERNAME, DASHBOARD_PASSWORD).
 *
 * Why this exists:
 *   The Voizo Vercel app has no user-auth system today. Until proper Supabase
 *   Auth is wired up (Phase 2), the dashboard + mutating API routes are
 *   reachable by anyone with the URL — meaning anyone could:
 *     - POST /api/vapi/clone-assistant → burn Vapi assistant slots ($)
 *     - POST /api/dnc → corrupt the suppression list (compliance)
 *     - POST /api/campaigns-v2/<id>/start → trigger calls at unauthorized times
 *
 *   Basic Auth is the smallest viable lock-down. Browsers prompt natively
 *   (no login UI needed), one env var pair gates everything.
 *
 * Excluded paths (handled elsewhere):
 *   /api/webhooks/*               — signed by Vapi/Twilio/Mobivate-side
 *                                   (HMAC, x-vapi-secret, reference UUID)
 *   /api/cron/*                   — Bearer CRON_SECRET (Vercel-injected)
 *   /api/freeswitch/originate     — own x-auth-secret header (Phase 0 PoC)
 *   /api/twiml/*                  — Twilio public-callable webhook
 *   /_next/*, /favicon, /icon     — static assets
 *
 * Env behavior:
 *   - Both DASHBOARD_USERNAME and DASHBOARD_PASSWORD set → enforce Basic Auth
 *   - Either missing AND NODE_ENV=production → 503 (refuse to serve, fail-closed)
 *   - Either missing AND NODE_ENV!=production → log warning + allow (dev convenience)
 *
 * Threat model out of scope:
 *   - Multi-user roles (operator vs admin vs viewer): Phase 2 Supabase Auth
 *   - Rate limiting: separate concern (Vercel's edge rate limit or Cloudflare)
 *   - 2FA: not in MVP
 *
 * Constant-time compare:
 *   Edge runtime doesn't expose crypto.timingSafeEqual (Node-only). We
 *   implement a manual constant-time string compare to prevent timing-attack
 *   inference of credentials.
 */

const PUBLIC_PATH_PREFIXES = [
  "/api/webhooks/",
  "/api/cron/",
  "/api/freeswitch/originate",
  "/api/twiml/",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function unauthorizedResponse(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Voizo", charset="UTF-8"',
      "Content-Type": "text/plain",
    },
  });
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 1. Public-path bypass (routes with their own auth) ──
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // ── 2. Read credentials from env ──
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;

  // ── 3. Misconfiguration handling ──
  if (!username || !password) {
    if (process.env.NODE_ENV === "production") {
      // Fail-closed: refuse to serve unauthenticated traffic in production
      console.error(
        "[middleware] DASHBOARD_USERNAME / DASHBOARD_PASSWORD not set in production — refusing to serve",
      );
      return new NextResponse("Auth not configured.", { status: 503 });
    }
    // Dev convenience: allow through with warning
    console.warn(
      "[middleware] DASHBOARD_USERNAME / DASHBOARD_PASSWORD not set — bypassing auth in non-production. " +
      "Set both in production env to lock down the deployment.",
    );
    return NextResponse.next();
  }

  // ── 4. Validate Basic Auth header ──
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorizedResponse();
  }

  let providedUser: string;
  let providedPass: string;
  try {
    const encoded = authHeader.slice("Basic ".length).trim();
    const decoded = atob(encoded);
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return unauthorizedResponse();
    providedUser = decoded.slice(0, colonIdx);
    providedPass = decoded.slice(colonIdx + 1);
  } catch {
    // Malformed Base64 in the Authorization header
    return unauthorizedResponse();
  }

  if (
    !constantTimeStringEqual(providedUser, username) ||
    !constantTimeStringEqual(providedPass, password)
  ) {
    return unauthorizedResponse();
  }

  return NextResponse.next();
}

export const config = {
  /**
   * Matcher excludes static asset paths so the middleware doesn't run on
   * every JS chunk / image fetch. The PUBLIC_PATH_PREFIXES check inside
   * the middleware then handles the API-route exemptions.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|robots\\.txt).*)",
  ],
};
