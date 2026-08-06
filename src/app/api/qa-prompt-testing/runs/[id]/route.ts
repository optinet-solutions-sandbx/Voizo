import { NextRequest, NextResponse } from "next/server";
import { getAnalysisRun } from "@/lib/qaBatchData";
import { getQaCallDetail } from "@/lib/qaPromptData";

/**
 * GET /api/qa-prompt-testing/runs/[id]
 *
 * One stored analysis run (its prompt + result) plus the full call it scored, so
 * the run-detail view can replay it (transcript + audio + customer/campaign +
 * the stored prompt and analysis). Read-only, lenient origin, service-role.
 */
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
    const run = await getAnalysisRun(id);
    if (!run) return NextResponse.json({ error: "Analysis run not found" }, { status: 404 });
    const call = await getQaCallDetail(run.callId);
    if (!call) return NextResponse.json({ error: "The scored call no longer exists" }, { status: 404 });
    return NextResponse.json({ run, call });
  } catch (err) {
    console.error("[qa-prompt-testing/runs/:id] failed:", err);
    return NextResponse.json({ error: "Failed to load analysis run" }, { status: 500 });
  }
}
