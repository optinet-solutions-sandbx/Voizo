import { NextRequest, NextResponse } from "next/server";
import { readNorthStar } from "@/lib/northStarData";

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * GET /api/qa/north-star — the loop's downstream anchor: delivered-among-goal-reached
 * (+ the no-sms / failed leaks), per campaign + portfolio. Behind Basic-Auth
 * (middleware) + origin-checked; reads non-PII columns via the service role.
 */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  try {
    const data = await readNorthStar();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[north-star] ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Failed to load north-star" }, { status: 500 });
  }
}
