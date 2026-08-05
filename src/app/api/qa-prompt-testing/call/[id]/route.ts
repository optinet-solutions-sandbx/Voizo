import { NextRequest, NextResponse } from "next/server";
import { getQaCallDetail } from "@/lib/qaPromptData";

/**
 * GET /api/qa-prompt-testing/call/[id]
 *
 * One call for the QA Prompt Testing detail view: normalized transcript + a
 * playable (proxied) audio URL, plus the customer (campaign_numbers_v2) and
 * campaign (campaigns_v2) context. Read-only, lenient origin (matches the other
 * dashboard/review GETs); service-role read.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const { id } = await ctx.params;
  try {
    const call = await getQaCallDetail(id);
    if (!call) return NextResponse.json({ error: "Call not found" }, { status: 404 });
    return NextResponse.json({ call });
  } catch (err) {
    console.error("[qa-prompt-testing/call/:id] failed:", err);
    return NextResponse.json({ error: "Failed to load call" }, { status: 500 });
  }
}
