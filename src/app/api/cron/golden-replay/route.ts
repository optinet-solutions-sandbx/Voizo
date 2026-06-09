import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { CRON_NAMES, recordHeartbeat, postSlackAlert } from "@/lib/alerts/slack";
import { qaJudgeReady, QA_JUDGE_MODEL } from "@/lib/qa/qaConfig";
import { judgeVersion } from "@/lib/qa/judgePrompt";
import { listGoldenSets, listRuns } from "@/lib/qa/goldenSetData";
import { replayJudgeOnGoldenSet } from "@/lib/qa/goldenReplay";
import { shouldAlertDrift, selectPriorRun } from "@/lib/qa/driftAlert";

export const maxDuration = 60; // seed-scale set; sequential replay is bounded (Golden spec §4.3)

const DRIFT_KAPPA_THRESHOLD = 0.6; // Landis-Koch "substantial"
const DRIFT_MIN_N = 10;

/**
 * GET /api/cron/golden-replay — Vercel Cron, daily (see vercel.json).
 * Auto-replays the judge against the ACTIVE (latest-version) golden set so the
 * calibration kappa time-series grows on its own (MLOps §4.4), and raises a Slack
 * WARN on a downward crossing below "substantial". OUT-OF-BAND: never the end-of-call
 * webhook; replayJudgeOnGoldenSet never writes qa_scores. Flag-gated: no-ops until
 * QA_JUDGE_ENABLED + the provider key are set.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[golden-replay] CRON_SECRET not set");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  const expected = `Bearer ${cronSecret}`;
  const received = request.headers.get("authorization") || "";
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!qaJudgeReady()) {
    console.log("[golden-replay] disabled (QA_JUDGE_ENABLED off or no key) — no-op");
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.goldenReplay);
    return NextResponse.json({ disabled: true });
  }

  // Active ruler = highest version (listGoldenSets returns version desc).
  const sets = await listGoldenSets();
  const active = sets[0] ?? null;
  if (!active) {
    console.log("[golden-replay] no frozen golden set — skip");
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.goldenReplay);
    return NextResponse.json({ skipped: "no-set" });
  }

  // Capture the PRIOR reading for this judge_version BEFORE the fresh run is written,
  // so the crossing check compares against the previous run, not itself.
  const jv = judgeVersion(QA_JUDGE_MODEL);
  const priorRun = selectPriorRun(await listRuns(active.id), jv);

  const replay = await replayJudgeOnGoldenSet({ version: active.version });
  const latest = { kappa: replay.result.cohens_kappa, n: replay.result.n };

  const decision = shouldAlertDrift({
    latest,
    prior: priorRun ? { kappa: priorRun.cohensKappa, n: priorRun.n } : null,
    threshold: DRIFT_KAPPA_THRESHOLD,
    minN: DRIFT_MIN_N,
  });

  let alerted = false;
  if (decision.alert) {
    alerted = await postSlackAlert("WARN", `Judge calibration drift — golden set v${active.version}`, [
      `judge_version=${replay.judgeVersion} model=${replay.judgeModel}`,
      `kappa=${latest.kappa} (n=${latest.n}); prior kappa=${priorRun?.cohensKappa ?? "none"}`,
      decision.reason,
      "Re-check the judge prompt/model; see /reviews -> Golden eval set.",
    ]);
  }

  console.log(
    `[golden-replay] v${active.version} jv=${replay.judgeVersion} kappa=${latest.kappa} n=${latest.n} persisted=${replay.persisted} alerted=${alerted} (${decision.reason})`,
  );
  await recordHeartbeat(supabaseAdmin, CRON_NAMES.goldenReplay);
  return NextResponse.json({
    version: active.version,
    judge_version: replay.judgeVersion,
    kappa: latest.kappa,
    n: latest.n,
    persisted: replay.persisted,
    alerted,
    reason: decision.reason,
  });
}
