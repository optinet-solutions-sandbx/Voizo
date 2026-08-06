import { NextRequest, NextResponse } from "next/server";
import { listAnalysisRuns } from "@/lib/qaBatchData";

/**
 * GET /api/qa-prompt-testing/runs?campaignId=&limit=&fromMs=&toMs=&callAttempt=&reachedCategory=
 *
 * Analysis History list + dashboard drill-down — stored bulk-analysis results, newest
 * first. Optional filters: campaign, call-date window [fromMs,toMs), and call_attempt /
 * reached_category (the analysis categories). Read-only, lenient origin, service-role.
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
  const num = (k: string): number | null => {
    const v = Number(sp.get(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const callAttempt = sp.get("callAttempt") || undefined;
  const reachedCategory = sp.get("reachedCategory") || undefined;
  try {
    const runs = await listAnalysisRuns({ campaignId, limit, fromMs: num("fromMs"), toMs: num("toMs"), callAttempt, reachedCategory });
    return NextResponse.json({ runs });
  } catch (err) {
    console.error("[qa-prompt-testing/runs] failed:", err);
    return NextResponse.json({ error: "Failed to load analysis history" }, { status: 500 });
  }
}
