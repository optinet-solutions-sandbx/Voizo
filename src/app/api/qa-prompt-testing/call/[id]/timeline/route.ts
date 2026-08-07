import { NextRequest, NextResponse } from "next/server";
import { getCallTimeline } from "@/lib/qaCallTimeline";

/**
 * GET /api/qa-prompt-testing/call/[id]/timeline
 *
 * Per-turn timing for the QA transcript, fetched live from Vapi (we don't store it).
 * Returns { available, reason?, durationSec, turns[] }. Always 200 with available:false
 * on any handled failure so the detail view falls back to the flat transcript cleanly.
 * Read-only, lenient origin (matches the sibling call route); Vapi read is server-side.
 */
export const maxDuration = 30;

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const { id } = await ctx.params;
  try {
    return NextResponse.json(await getCallTimeline(id));
  } catch (err) {
    console.error("[qa-prompt-testing/call/:id/timeline] failed:", err);
    return NextResponse.json({ available: false, reason: "error", durationSec: null, turns: [] });
  }
}
