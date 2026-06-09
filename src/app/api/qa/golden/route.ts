import { NextRequest, NextResponse } from "next/server";
import { listGoldenSets, listRuns } from "@/lib/qa/goldenSetData";

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
 * GET /api/qa/golden — list frozen golden-eval-set versions, each with its latest
 * replay (kappa/agreement on the fixed ruler) + run count. Behind Basic-Auth
 * (middleware) + origin-checked; reads via the service role.
 */
export async function GET(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });

  const sets = await listGoldenSets();
  const withRuns = await Promise.all(
    sets.map(async (s) => {
      const runs = await listRuns(s.id); // newest-first
      return {
        ...s,
        latestRun: runs[0] ?? null,
        runCount: runs.length,
        // capped, oldest->newest, kappa-only — for the panel sparkline (runCount stays exact)
        runs: runs
          .slice(0, 30)
          .reverse()
          .map((r) => ({ cohensKappa: r.cohensKappa, n: r.n, createdAt: r.createdAt })),
      };
    }),
  );
  return NextResponse.json({ sets: withRuns });
}
