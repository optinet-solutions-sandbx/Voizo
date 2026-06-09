import { NextRequest, NextResponse } from "next/server";
import { fetchAgentPerformance } from "@/lib/qa/agentPerfData";

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
 * GET /api/qa/agent-performance — read-only agent observability: verdict mix, top
 * failure themes (rule-based clustering of judge rationales), per-base-agent rollup.
 * Behind Basic-Auth (middleware) + origin-checked; non-PII columns via the service
 * role. Off the call path; reads existing qa_scores (the judge need not be live).
 */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  try {
    const data = await fetchAgentPerformance();
    return NextResponse.json(data);
  } catch (err) {
    console.error(`[agent-performance] ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: "Failed to load agent performance" }, { status: 500 });
  }
}
