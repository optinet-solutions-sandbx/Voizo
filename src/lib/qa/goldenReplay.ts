// src/lib/qa/goldenReplay.ts
// Re-run the judge against a FROZEN golden set → a kappa comparable across judge
// versions on a fixed ruler (MLOps §4.2/§4.4). Thin orchestrator: it reuses the
// existing pure scorer (scoreTranscript) + pure calibration (computeCalibration) and
// only adds the fetch → score → assemble → record glue. It NEVER writes qa_scores —
// a golden replay is a separate eval, not production scoring (that is what keeps the
// ruler fixed and the comparison honest).
import { QA_JUDGE_MODEL } from "./qaConfig";
import { judgeVersion } from "./judgePrompt";
import { scoreTranscript, type JudgeClient } from "./scoreCall";
import { computeCalibration, type CalibrationResult } from "./qaScoreMath";
import { toCalibrationRows, type JudgeOutcome } from "./goldenSetMath";
import { getSetIdByVersion, getGoldenItems, recordRun } from "./goldenSetData";

export interface ReplayResult {
  setId: string;
  version: number;
  judgeVersion: string;
  judgeModel: string;
  result: CalibrationResult;
  scored: number; // items the judge returned a verdict for
  skipped: Record<string, number>; // ScoreSkip reason -> count (api-error, unparsable, …)
  persisted: boolean; // false ⇒ the kappa was computed but the drift-log row failed to write (retry)
}

/**
 * Replay the judge over the frozen set at `version`. Sequential (boring & correct at
 * seed scale — Manifesto §4 "no parallelism before sequential works"; a large set
 * would want a concurrency limit / batching, and bounds the route maxDuration).
 * `minDurationSeconds: 0` — golden items are pre-vetted real conversations, so a
 * genuine short call ("yes, text me, bye") must not be dropped by the cost guard.
 * Per-item judge errors are TALLIED (not thrown) so a flaky API yields n=0 + an error
 * count, never a false kappa. Throws only if the set is missing or items can't be read.
 */
export async function replayJudgeOnGoldenSet(opts: {
  version: number;
  model?: string;
  client?: JudgeClient | null;
}): Promise<ReplayResult> {
  const set = await getSetIdByVersion(opts.version);
  if (!set) throw new Error(`golden set version ${opts.version} not found`);

  const model = opts.model ?? QA_JUDGE_MODEL;
  const jv = judgeVersion(model); // computed upfront so recordRun is labelled even if every item skips

  const items = await getGoldenItems(set.id);

  const judgeByItem = new Map<string, JudgeOutcome>();
  const skipped: Record<string, number> = {};
  let scored = 0;
  for (const it of items) {
    const r = await scoreTranscript(
      { transcript: it.transcript, durationSeconds: it.durationSeconds },
      { model, client: opts.client, minDurationSeconds: 0 },
    );
    if (r.ok) {
      judgeByItem.set(it.id, r.verdict.success_verdict);
      scored++;
    } else {
      judgeByItem.set(it.id, null);
      skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
    }
  }

  const rows = toCalibrationRows(
    items.map((it) => ({ id: it.id, callId: it.callId, humanVerdict: it.humanVerdict })),
    judgeByItem,
  );
  const result = computeCalibration(rows);

  // Best-effort: a drift-log write failure must not discard the kappa we just computed,
  // but it MUST be visible (else the UI shows a kappa that was never persisted). Thread
  // the {ok} out as `persisted` so the caller/route can flag "computed but not saved".
  const rec = await recordRun({
    setId: set.id,
    judgeVersion: jv,
    judgeModel: model,
    result,
    runMeta: { items: items.length, scored, skipped },
  });

  return {
    setId: set.id,
    version: set.version,
    judgeVersion: jv,
    judgeModel: model,
    result,
    scored,
    skipped,
    persisted: rec.ok,
  };
}
