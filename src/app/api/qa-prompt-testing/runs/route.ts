import { NextRequest, NextResponse } from "next/server";
import { listAnalysisRuns } from "@/lib/qaBatchData";

/**
 * GET /api/qa-prompt-testing/runs?campaignId=&limit=
 *
 * Analysis History list — stored bulk-analysis results, newest first, optionally
 * scoped to one campaign. Read-only, lenient origin, service-role.
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
  const campaignId = sp.get("campaignId") || undefined;
  const limitRaw = Number(sp.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(2000, limitRaw) : 500;
  try {
    const runs = await listAnalysisRuns({ campaignId, limit });
    return NextResponse.json({ runs });
  } catch (err) {
    console.error("[qa-prompt-testing/runs] failed:", err);
    return NextResponse.json({ error: "Failed to load analysis history" }, { status: 500 });
  }
}
