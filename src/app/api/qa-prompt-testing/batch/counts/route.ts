import { NextRequest, NextResponse } from "next/server";
import { reachedCounts } from "@/lib/qaBatchData";

/**
 * GET /api/qa-prompt-testing/batch/counts?campaignId=&promptId=
 *
 * For the submit card: how many reached calls (person or voicemail, with a
 * transcript) exist in the campaign, and how many are not yet analyzed with the
 * chosen prompt. Read-only, lenient origin, service-role.
 */
export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }
  const sp = new URL(request.url).searchParams;
  const campaignId = sp.get("campaignId") || "";
  const promptId = sp.get("promptId") || null;
  if (!campaignId) return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  try {
    const counts = await reachedCounts(campaignId, promptId);
    return NextResponse.json(counts);
  } catch (err) {
    console.error("[qa-prompt-testing/batch/counts] failed:", err);
    return NextResponse.json({ error: "Failed to count calls" }, { status: 500 });
  }
}
