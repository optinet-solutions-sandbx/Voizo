// src/lib/qa/goldenSetData.ts
// Service-role data layer for the Golden Eval Set (the frozen, versioned ruler).
// Mirrors qaScoreData.ts / labelData.ts: supabaseAdmin bypasses default-deny RLS;
// NEVER call from the client. PURE math lives in ./goldenSetMath (testable without env).
//
// freeze/getGoldenItems THROW on hard DB errors (operator-triggered; surface failures
// to the route). recordRun/list* are best-effort reads that degrade to [] / {ok:false}.
import { supabaseAdmin } from "../supabaseServer";
import { hasRealConversation, isVoicemail } from "../transcriptClassify";
import type { CalibrationResult } from "./qaScoreMath";
import { dedupeLabelsByCall, type PromptScoreRow, type RawLabel } from "./goldenSetMath";

// calls_v2.transcript / golden_eval_items.transcript is jsonb written as { text: "<flat string>" }
// (older rows may be a raw string). Local copy mirrors labelData.transcriptText — kept here so
// this module touches no shared file (the codebase already duplicates this 5-liner per layer).
function transcriptText(t: unknown): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (typeof t === "object") {
    const text = (t as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

export interface FreezeResult {
  setId: string;
  version: number;
  itemCount: number;
  skipped: { voicemail: number; noConversation: number; missingCall: number; tie: number };
}

/**
 * Cut a NEW frozen golden-set version from the current CLEAN, DECIDED labels.
 * Selects call_labels with verdict in (good,bad), re-applies hasRealConversation
 * && !isVoicemail at freeze (so the set is clean regardless of label hygiene — #4
 * defense-in-depth), and writes immutable transcript COPIES. Optional campaign /
 * date filters. Throws on hard DB error (route → 500; a unique(version) clash on a
 * concurrent freeze surfaces here as a Postgres error the route reports).
 */
export async function freezeGoldenSet(
  opts: { note?: string; campaignIds?: string[]; since?: string; until?: string } = {},
): Promise<FreezeResult> {
  // 1. Clean DECIDED labels (good/bad only; 'unsure' is not a ruler entry). Tiny set — no paging.
  const { data: labels, error: lErr } = await supabaseAdmin
    .from("call_labels")
    .select("call_id, verdict, reason, labeled_by")
    .in("verdict", ["good", "bad"]);
  if (lErr) throw lErr;
  const labelRows = (labels ?? []) as Array<{
    call_id: string;
    verdict: "good" | "bad";
    reason: string | null;
    labeled_by: string;
  }>;

  // 2. Fetch the labeled calls (chunked .in(), mirrors qaScoreData).
  const callIds = [...new Set(labelRows.map((l) => l.call_id))];
  const callById = new Map<
    string,
    { campaignId: string; createdAt: string; transcript: string; durationSeconds: number | null; goalReached: boolean | null }
  >();
  for (let i = 0; i < callIds.length; i += 500) {
    const { data, error } = await supabaseAdmin
      .from("calls_v2")
      .select("id, campaign_id, created_at, duration_seconds, goal_reached, transcript")
      .in("id", callIds.slice(i, i + 500));
    if (error) throw error;
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      callById.set(r.id as string, {
        campaignId: r.campaign_id as string,
        createdAt: r.created_at as string,
        transcript: transcriptText(r.transcript),
        durationSeconds: (r.duration_seconds as number | null) ?? null,
        goalReached: (r.goal_reached as boolean | null) ?? null,
      });
    }
  }

  // 3a. Collapse multi-reviewer labels to ONE verdict per call (majority; ties dropped),
  //     so the freeze emits at most one item per call_id (else unique(set_id,call_id)
  //     rejects the whole batch). Single-reviewer calls (today) pass through unchanged.
  const uniqueCallIds = new Set(labelRows.map((l) => l.call_id)).size;
  const deduped = dedupeLabelsByCall(
    labelRows.map(
      (l): RawLabel => ({ callId: l.call_id, verdict: l.verdict, reason: l.reason, labeledBy: l.labeled_by }),
    ),
  );
  const skipped = { voicemail: 0, noConversation: 0, missingCall: 0, tie: uniqueCallIds - deduped.length };

  // 3b. Join + clean filter (+ optional campaign / date-range scoping). One item per call.
  const campaignSet = opts.campaignIds && opts.campaignIds.length ? new Set(opts.campaignIds) : null;
  const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
  const untilMs = opts.until ? Date.parse(opts.until) : NaN;
  const items: Array<{
    call_id: string;
    source: "real";
    transcript: { text: string };
    human_verdict: "good" | "bad";
    human_reason: string | null;
    labeled_by: string;
    duration_seconds: number | null;
    goal_reached_at_freeze: boolean | null;
  }> = [];
  for (const d of deduped) {
    const call = callById.get(d.callId);
    if (!call) {
      skipped.missingCall++;
      continue;
    }
    if (campaignSet && !campaignSet.has(call.campaignId)) continue; // out of scope (not a dirty-skip)
    if (Number.isFinite(sinceMs)) {
      const m = Date.parse(call.createdAt);
      if (Number.isFinite(m) && m < sinceMs) continue;
    }
    if (Number.isFinite(untilMs)) {
      const m = Date.parse(call.createdAt);
      if (Number.isFinite(m) && m > untilMs) continue;
    }
    if (!hasRealConversation(call.transcript)) {
      skipped.noConversation++;
      continue;
    }
    if (isVoicemail(call.transcript)) {
      skipped.voicemail++;
      continue;
    }
    items.push({
      call_id: d.callId,
      source: "real",
      transcript: { text: call.transcript }, // FROZEN copy, in the {text} shape the scorer reads back
      human_verdict: d.verdict,
      human_reason: d.reason,
      labeled_by: d.labeledBy,
      duration_seconds: call.durationSeconds,
      goal_reached_at_freeze: call.goalReached,
    });
  }

  // 4. Next monotonic version.
  const { data: maxRow, error: mErr } = await supabaseAdmin
    .from("golden_eval_sets")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (mErr) throw mErr;
  const version = ((maxRow?.version as number | undefined) ?? 0) + 1;

  // 5. Insert the set (item_count known upfront).
  const { data: setRow, error: sErr } = await supabaseAdmin
    .from("golden_eval_sets")
    .insert({
      version,
      note: opts.note ?? null,
      source_filter: {
        campaignIds: opts.campaignIds ?? null,
        since: opts.since ?? null,
        until: opts.until ?? null,
        candidateLabels: labelRows.length,
        skipped,
      },
      item_count: items.length,
    })
    .select("id, version")
    .single();
  if (sErr || !setRow) throw sErr ?? new Error("golden_eval_sets insert failed");
  const setId = setRow.id as string;

  // 6. Insert the frozen items. PostgREST has no cross-statement transaction, so on
  //    failure we COMPENSATE by deleting the set row created in step 5 — a failed freeze
  //    must never strand a phantom set with item_count>0 and zero items.
  if (items.length) {
    const { error: iErr } = await supabaseAdmin
      .from("golden_eval_items")
      .insert(items.map((it) => ({ ...it, set_id: setId })));
    if (iErr) {
      await supabaseAdmin.from("golden_eval_sets").delete().eq("id", setId);
      throw iErr;
    }
  }

  return { setId, version: setRow.version as number, itemCount: items.length, skipped };
}

export interface GoldenSetSummary {
  id: string;
  version: number;
  note: string | null;
  itemCount: number;
  createdAt: string;
}

/** All frozen sets, newest version first. Best-effort → [] on error (UI list). */
export async function listGoldenSets(): Promise<GoldenSetSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("golden_eval_sets")
    .select("id, version, note, item_count, created_at")
    .order("version", { ascending: false });
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    version: r.version as number,
    note: (r.note as string | null) ?? null,
    itemCount: (r.item_count as number) ?? 0,
    createdAt: r.created_at as string,
  }));
}

export interface GoldenItem {
  id: string;
  callId: string | null;
  transcript: string;
  humanVerdict: "good" | "bad";
  durationSeconds: number | null;
}

/** The frozen items of one set, ready for the scorer. THROWS on DB error (replay must
 *  not mistake a DB failure for an empty set). */
export async function getGoldenItems(setId: string): Promise<GoldenItem[]> {
  const { data, error } = await supabaseAdmin
    .from("golden_eval_items")
    .select("id, call_id, transcript, human_verdict, duration_seconds")
    .eq("set_id", setId);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    callId: (r.call_id as string | null) ?? null,
    transcript: transcriptText(r.transcript),
    humanVerdict: r.human_verdict as "good" | "bad",
    durationSeconds: (r.duration_seconds as number | null) ?? null,
  }));
}

/** Resolve a set id by its version. null when absent. */
export async function getSetIdByVersion(version: number): Promise<{ id: string; version: number } | null> {
  const { data, error } = await supabaseAdmin
    .from("golden_eval_sets")
    .select("id, version")
    .eq("version", version)
    .maybeSingle();
  if (error || !data) return null;
  return { id: data.id as string, version: data.version as number };
}

/** Append one replay result to the drift log. Best-effort: never throws (a logging
 *  failure must not discard the computed kappa the caller already holds). */
export async function recordRun(input: {
  setId: string;
  judgeVersion: string;
  judgeModel: string;
  result: CalibrationResult;
  runMeta: Record<string, unknown>;
}): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabaseAdmin.from("golden_eval_runs").insert({
      set_id: input.setId,
      judge_version: input.judgeVersion,
      judge_model: input.judgeModel,
      n: input.result.n,
      agreement: input.result.agreement,
      cohens_kappa: input.result.cohens_kappa,
      tp: input.result.matrix.tp,
      tn: input.result.matrix.tn,
      fp: input.result.matrix.fp,
      fn: input.result.matrix.fn,
      run_meta: input.runMeta,
    });
    if (error) {
      console.warn(`[golden] recordRun failed for set ${input.setId}: ${error.message}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[golden] recordRun threw: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}

export interface RunSummary {
  judgeVersion: string;
  judgeModel: string;
  n: number;
  agreement: number | null;
  cohensKappa: number | null;
  createdAt: string;
}

/** The drift log for one set, newest first. Best-effort → []. */
export async function listRuns(setId: string): Promise<RunSummary[]> {
  const { data, error } = await supabaseAdmin
    .from("golden_eval_runs")
    .select("judge_version, judge_model, n, agreement, cohens_kappa, created_at")
    .eq("set_id", setId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return (data as Array<Record<string, unknown>>).map((r) => ({
    judgeVersion: r.judge_version as string,
    judgeModel: r.judge_model as string,
    n: (r.n as number) ?? 0,
    agreement: (r.agreement as number | null) ?? null,
    cohensKappa: (r.cohens_kappa as number | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

/** qa_scores attribution rows for the v7-vs-v6 readout. Paged (mirrors selectUnscoredCalls).
 *  THROWS on a query error — unlike a bounded cron sample, this read IS the analysis, so a
 *  silently-truncated read would present a WRONG comparison as fact (review M3). The route
 *  maps the throw to a 500; a genuinely empty qa_scores returns [] (correctly empty). Optional
 *  campaign scope (prompt_versions are campaign-keyed, so a v7-vs-v6 comparison is normally
 *  within one campaign). */
export async function selectScoresForPromptStats(campaignId?: string): Promise<PromptScoreRow[]> {
  const PAGE = 1000;
  const out: PromptScoreRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabaseAdmin.from("qa_scores").select("prompt_version_id, prompt_version_match, success_verdict");
    if (campaignId) q = q.eq("campaign_id", campaignId);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data) break;
    for (const r of data as Array<Record<string, unknown>>) {
      out.push({
        prompt_version_id: (r.prompt_version_id as string | null) ?? null,
        prompt_version_match: (r.prompt_version_match as string) ?? "unresolved",
        success_verdict: (r.success_verdict as string | null) ?? null,
      });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

/** created_at per prompt_version id — the readable label for the "how each script
 *  version scored" UI (prompt_versions has no human name, so the date is the label).
 *  Best-effort → {} on error; chunked .in() like the call fetch above. */
export async function selectPromptVersionDates(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabaseAdmin
      .from("prompt_versions")
      .select("id, created_at")
      .in("id", ids.slice(i, i + 500));
    if (error) {
      console.warn(`[golden] selectPromptVersionDates failed: ${error.message}`);
      return out;
    }
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      out[r.id as string] = r.created_at as string;
    }
  }
  return out;
}
