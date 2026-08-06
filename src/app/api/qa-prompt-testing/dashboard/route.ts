import { NextRequest, NextResponse } from "next/server";
import { getQaAnalysisDashboard } from "@/lib/qaBatchData";

/**
 * GET /api/qa-prompt-testing/dashboard?days=
 *
 * Read-only roll-up of the QA prompt-analysis results (listener_qa_analysis_runs)
 * for the temporary QA dashboard. Completely isolated from the campaigns dashboard
 * — reads only the analysis table (+ campaign names). `days` optionally scopes to
 * the last N days by analyzed_at (omit for all-time). Lenient origin; service-role.
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
  const daysRaw = Number(new URL(request.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;
  try {
    const data = await getQaAnalysisDashboard({ days });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[qa-prompt-testing/dashboard] failed:", err);
    return NextResponse.json({ error: "Failed to build QA dashboard" }, { status: 500 });
  }
}
