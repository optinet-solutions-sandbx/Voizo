// src/lib/qaScoreData.ts
// Service-role data layer for qa_scores. Mirrors promptVersionData.ts (never throws
// on the cron path; supabaseAdmin bypasses default-deny RLS; NEVER call from client).
// PURE math/attribution helpers live in ./qa/qaScoreMath (testable without env).
import { supabaseAdmin } from "./supabaseServer";
import { hasRealConversation } from "./transcriptClassify";
import type { JudgeVerdict } from "./qa/judgePrompt";
import { attributePromptVersion, type PromptAttribution } from "./qa/qaScoreMath";

export interface CandidateCall {
  id: string;
  campaignId: string;
  createdAt: string;
  transcript: string;
  durationSeconds: number | null;
  goalReached: boolean | null;
}

const txt = (t: unknown): string =>
  typeof t === "string"
    ? t
    : t && typeof t === "object" && typeof (t as { text?: unknown }).text === "string"
    ? (t as { text: string }).text
    : "";

/** Resolve attribution for one call by reading its campaign's prompt_versions. Best-effort. */
export async function resolvePromptVersion(
  campaignId: string,
  callCreatedAt: string,
): Promise<PromptAttribution> {
  try {
    const { data, error } = await supabaseAdmin
      .from("prompt_versions")
      .select("id, created_at")
      .eq("campaign_id", campaignId);
    if (error || !data) return { promptVersionId: null, match: "unresolved" };
    return attributePromptVersion(callCreatedAt, data as Array<{ id: string; created_at: string }>);
  } catch {
    return { promptVersionId: null, match: "unresolved" };
  }
}

/** Candidate real conversations with NO qa_scores row for this judge_version. Paged,
 *  classify-on-read (mirrors labelData). `cap` bounds the returned set. */
export async function selectUnscoredCalls(
  judgeVersion: string,
  cap: number,
  campaignId?: string,
): Promise<CandidateCall[]> {
  const PAGE = 1000;
  const MAX_PAGES = 12; // hard ceiling independent of `cap` — bounds DB read/classify per tick
  const safeCap = Math.max(1, Math.floor(Number.isFinite(cap) ? cap : 1));
  const candidates: CandidateCall[] = [];
  for (let from = 0; from < MAX_PAGES * PAGE; from += PAGE) {
    let q = supabaseAdmin
      .from("calls_v2")
      .select("id, campaign_id, created_at, duration_seconds, goal_reached, transcript")
      .not("transcript", "is", null);
    if (campaignId) q = q.eq("campaign_id", campaignId);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    for (const r of data as Array<Record<string, unknown>>) {
      const transcript = txt(r.transcript);
      if (!hasRealConversation(transcript)) continue;
      candidates.push({
        id: r.id as string,
        campaignId: r.campaign_id as string,
        createdAt: r.created_at as string,
        transcript,
        durationSeconds: (r.duration_seconds as number | null) ?? null,
        goalReached: (r.goal_reached as boolean | null) ?? null,
      });
    }
    if (data.length < PAGE) break;
    if (candidates.length >= safeCap * 5) break; // bound the scan; we filter scored next
  }
  // Subtract already-scored ids for this judge_version (chunked .in()).
  const scored = new Set<string>();
  const ids = candidates.map((c) => c.id);
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await supabaseAdmin
      .from("qa_scores")
      .select("call_id")
      .eq("judge_version", judgeVersion)
      .in("call_id", ids.slice(i, i + 500));
    for (const s of (data ?? []) as Array<{ call_id: string }>) scored.add(s.call_id);
  }
  return candidates.filter((c) => !scored.has(c.id)).slice(0, safeCap);
}

/** Count qa_scores rows created today (UTC) — backs the daily cap. */
export async function countScoresToday(): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count } = await supabaseAdmin
    .from("qa_scores")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since.toISOString());
  return count ?? 0;
}

export interface UpsertScoreInput {
  callId: string;
  campaignId: string;
  createdAt: string;
  verdict: JudgeVerdict;
  goalReachedAtScore: boolean | null;
  judgeModel: string;
  judgeVersion: string;
  meta: Record<string, unknown>;
}
/** Upsert one verdict (overwrite-in-place per call+judge_version). Never throws. */
export async function upsertQaScore(input: UpsertScoreInput): Promise<{ ok: boolean }> {
  try {
    const attr = await resolvePromptVersion(input.campaignId, input.createdAt);
    const { error } = await supabaseAdmin.from("qa_scores").upsert(
      {
        call_id: input.callId,
        campaign_id: input.campaignId,
        prompt_version_id: attr.promptVersionId,
        prompt_version_match: attr.match,
        success_verdict: input.verdict.success_verdict,
        success_confidence: input.verdict.success_confidence,
        success_path: input.verdict.success_path,
        goal_reached_at_score: input.goalReachedAtScore,
        axis_accuracy: input.verdict.axis_accuracy,
        axis_clarity: input.verdict.axis_clarity,
        axis_natural_flow: input.verdict.axis_natural_flow,
        rationale: input.verdict.rationale,
        judge_model: input.judgeModel,
        judge_version: input.judgeVersion,
        judge_meta: input.meta,
      },
      { onConflict: "call_id,judge_version" },
    );
    if (error) {
      console.warn(`[qa] upsert failed for ${input.callId}: ${error.message}`);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn(`[qa] upsert threw for ${input.callId}: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false };
  }
}

/** Read the calibration confusion data for a judge_version (+ optional campaign). Empty-but-valid when none. */
export async function readCalibration(
  judgeVersion?: string,
  campaignId?: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    let q = supabaseAdmin.from("qa_calibration").select("*");
    if (judgeVersion) q = q.eq("judge_version", judgeVersion);
    if (campaignId) q = q.eq("campaign_id", campaignId);
    const { data } = await q;
    return (data ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

export interface CampaignScore {
  callId: string;
  verdict: string | null;
  confidence: number | null;
  path: string | null;
  rationale: string | null;
  judgeVersion: string;
}

/** This campaign's qa_scores for a judge_version, shaped for the Reviews UI. Never throws → []. */
export async function selectCampaignScores(campaignId: string, judgeVersion: string): Promise<CampaignScore[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("qa_scores")
      .select("call_id, success_verdict, success_confidence, success_path, rationale, judge_version")
      .eq("campaign_id", campaignId)
      .eq("judge_version", judgeVersion);
    if (error || !data) return [];
    return (data as Array<Record<string, unknown>>).map((r) => ({
      callId: r.call_id as string,
      verdict: (r.success_verdict as string | null) ?? null,
      confidence: (r.success_confidence as number | null) ?? null,
      path: (r.success_path as string | null) ?? null,
      rationale: (r.rationale as string | null) ?? null,
      judgeVersion: r.judge_version as string,
    }));
  } catch {
    return [];
  }
}
