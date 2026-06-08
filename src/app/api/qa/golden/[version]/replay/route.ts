import { NextRequest, NextResponse } from "next/server";
import { replayJudgeOnGoldenSet } from "@/lib/qa/goldenReplay";
import { qaJudgeReady } from "@/lib/qa/qaConfig";

export const maxDuration = 60;

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
 * POST /api/qa/golden/[version]/replay — re-run the judge over the FROZEN set at
 * `version` → store a drift-log run → return kappa/agreement on the fixed ruler.
 * Judge-calling, so flag-gated (qaJudgeReady) + origin-checked + Basic-Auth (middleware).
 * Sequential scoring inside; maxDuration=60 bounds it at seed scale.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ version: string }> }) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  if (!qaJudgeReady()) return NextResponse.json({ error: "QA judge disabled" }, { status: 503 });

  const { version: vStr } = await ctx.params;
  const version = Number.parseInt(vStr, 10);
  if (!Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: "version must be a positive integer" }, { status: 400 });
  }

  try {
    const result = await replayJudgeOnGoldenSet({ version });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[golden/replay] ${msg}`);
    const notFound = msg.includes("not found");
    return NextResponse.json(
      { error: notFound ? `golden set version ${version} not found` : "Replay failed" },
      { status: notFound ? 404 : 500 },
    );
  }
}
