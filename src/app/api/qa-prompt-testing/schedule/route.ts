import { NextRequest, NextResponse } from "next/server";
import { getQaSchedule, setQaSchedule } from "@/lib/qaBatchData";

/**
 * GET  /api/qa-prompt-testing/schedule            → current daily-analysis config
 * PUT  /api/qa-prompt-testing/schedule  { enabled?, promptId? }
 *
 * Singleton config for the /api/cron/qa-analysis-daily auto-run. Enabling it starts
 * standing daily OpenAI spend (analyzes yesterday's reached calls across all campaigns).
 */
export const dynamic = "force-dynamic";

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

export async function GET() {
  try {
    return NextResponse.json(await getQaSchedule());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load schedule" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  let body: { enabled?: unknown; promptId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const patch: { enabled?: boolean; promptId?: string | null } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.promptId === "string") patch.promptId = body.promptId;
  else if (body.promptId === null) patch.promptId = null;

  if (patch.enabled === true && patch.promptId === undefined) {
    // Enabling without an explicit prompt requires one already stored.
    const cur = await getQaSchedule();
    if (!cur.promptId) return NextResponse.json({ error: "Choose a prompt before enabling the daily schedule." }, { status: 400 });
  }
  try {
    await setQaSchedule(patch);
    return NextResponse.json(await getQaSchedule());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save schedule" }, { status: 500 });
  }
}
