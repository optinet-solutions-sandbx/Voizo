import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Browsers omit the Origin header on same-origin GETs, so for read-only
// routes we only reject when an Origin is present AND it disagrees with
// the Host. See feedback_csrf_origin_check_get_lenient.
export function rejectIfCrossOrigin(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return null;
  try {
    if (new URL(origin).host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }
  return null;
}

// For mutating routes (POST/PATCH/DELETE) a missing Origin header is
// itself suspicious — fetch() adds one for cross-origin requests and
// browsers add one on same-origin POSTs. Reject when absent.
export function rejectIfCrossOriginStrict(request: NextRequest): NextResponse | null {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  try {
    if (new URL(origin).host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }
  return null;
}
