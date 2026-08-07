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
  const sp = new URL(request.url).searchParams;
  const num = (k: string): number | null => {
    const v = Number(sp.get(k));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const dayRaw = sp.get("day");
  const day = dayRaw && /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) ? dayRaw : null;
  try {
    const data = await getQaAnalysisDashboard({ fromMs: num("fromMs"), toMs: num("toMs"), day });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[qa-prompt-testing/dashboard] failed:", err);
    return NextResponse.json({ error: "Failed to build QA dashboard" }, { status: 500 });
  }
}
