import { NextRequest, NextResponse } from "next/server";
import { readCalibration } from "@/lib/qaScoreData";
import { computeCalibration } from "@/lib/qa/qaScoreMath";
import { judgeVersion } from "@/lib/qa/judgePrompt";
import { QA_JUDGE_MODEL } from "@/lib/qa/qaConfig";

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
 * GET /api/qa/calibration — judge-vs-human confusion matrix + %-agreement + Cohen's
 * kappa on the success axis for one judge_version. Empty-but-valid when no overlap
 * (the calibration RUN waits on the clean labeling drive + score-backfill).
 */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const { searchParams } = new URL(request.url);
  const jv = searchParams.get("judgeVersion") || judgeVersion(QA_JUDGE_MODEL);
  const rows = await readCalibration(jv);
  const cal = computeCalibration(
    rows.map((r) => ({
      call_id: r.call_id as string,
      success_verdict: (r.success_verdict as string | null) ?? null,
      human_success: (r.human_success as string | null) ?? null,
    })),
  );

  return NextResponse.json({
    judge_version: jv,
    ...cal,
    note:
      cal.n === 0 ? "no overlapping judge+human labels yet — run the labeling drive + score-backfill" : undefined,
  });
}
