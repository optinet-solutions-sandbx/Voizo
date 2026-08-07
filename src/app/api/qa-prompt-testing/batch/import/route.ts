import { NextRequest, NextResponse } from "next/server";
import { importCompletedBatches } from "@/lib/qaBatchSubmit";

/**
 * POST /api/qa-prompt-testing/batch/import
 *
 * In-app import sweep: poll all active batches, then import every completed-but-unimported
 * one into listener_qa_analysis_runs. Idempotent + resume-safe — safe to click repeatedly.
 * (The qa-import-sweep cron calls the same importCompletedBatches() on a schedule.)
 */
export const maxDuration = 300;

function crossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function POST(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
  try {
    const result = await importCompletedBatches(apiKey);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Import sweep failed" }, { status: 500 });
  }
}
