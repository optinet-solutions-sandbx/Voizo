import { NextRequest, NextResponse } from "next/server";
import { getAllBatchJobs, pollActiveJobs } from "@/lib/qaBatchData";

/**
 * GET /api/qa-prompt-testing/batches
 *
 * All batch jobs across every campaign (newest first, each with its campaign
 * name), polling OpenAI for the still-active ones so Analysis History can show
 * live batch progress for monitoring. Read-only, lenient origin, service-role.
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
  try {
    const jobs = await getAllBatchJobs();
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) await pollActiveJobs(jobs, apiKey);
    return NextResponse.json({ jobs });
  } catch (err) {
    console.error("[qa-prompt-testing/batches] failed:", err);
    return NextResponse.json({ error: "Failed to load batches" }, { status: 500 });
  }
}
