// src/lib/qa/agentPerfData.ts
// Service-role data layer for the Agent Performance panel. supabaseAdmin reads via the
// service role (bypasses RLS). qa_scores is default-deny RLS; campaigns_v2 is the legacy
// allow-all table (separately tracked) — we read only its non-PII name/flags. NEVER call
// from the client. PURE math in ./agentPerfMath (testable without env). Reads NON-PII
// columns only (rationale is the judge's one-line summary, not the transcript). Scoped to
// the CURRENT judge_version so re-scored calls aren't double-counted. Off the call path.
import { supabaseAdmin } from "../supabaseServer";
import { judgeVersion } from "./judgePrompt";
import { QA_JUDGE_MODEL } from "./qaConfig";
import {
  computeVerdictMix,
  topFailureThemes,
  rollupByBaseAgent,
  type CampaignMeta,
  type VerdictMix,
  type FailureThemeCount,
  type AgentRollup,
} from "./agentPerfMath";

export interface AgentPerfResult {
  verdictMix: VerdictMix;
  failureThemes: FailureThemeCount[];
  agents: AgentRollup[];
  meta: {
    totalScores: number;
    nonTestScores: number;
    excludedTestScores: number;
    resolvedToBase: number;
    judgeModel: string | null;
    judgeVersion: string;
  };
}

interface ScoreRow {
  call_id: string;
  campaign_id: string | null;
  success_verdict: string | null;
  rationale: string | null;
  axis_accuracy: number | null;
  axis_clarity: number | null;
  axis_natural_flow: number | null;
  judge_model: string | null;
}

/**
 * Read all qa_scores (non-PII cols) + the campaigns they belong to, and compose the
 * three views. THROWS on a paging/query error — this read IS the analysis, so a
 * truncated read would present wrong totals as fact (golden review M3). The route maps
 * the throw to 500; a genuinely empty qa_scores returns zeroed structures.
 */
export async function fetchAgentPerformance(): Promise<AgentPerfResult> {
  // Scope to the CURRENT judge_version: qa_scores has unique(call_id, judge_version) and
  // APPENDS a new row when the judge is re-tuned, so reading every version would
  // double-count re-scored calls. Mirrors selectCampaignScores / calibration (.eq jv).
  const jv = judgeVersion(QA_JUDGE_MODEL);
  const PAGE = 1000;
  const rows: ScoreRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("qa_scores")
      .select("call_id, campaign_id, success_verdict, rationale, axis_accuracy, axis_clarity, axis_natural_flow, judge_model")
      .eq("judge_version", jv)
      .order("id", { ascending: true }) // stable page boundaries — no skip/dup past PAGE rows
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data) break;
    for (const r of data as Array<Record<string, unknown>>) {
      rows.push({
        call_id: (r.call_id as string | null) ?? "", // NOT NULL in schema; "" is an unreachable guard
        campaign_id: (r.campaign_id as string | null) ?? null,
        success_verdict: (r.success_verdict as string | null) ?? null,
        rationale: (r.rationale as string | null) ?? null,
        axis_accuracy: (r.axis_accuracy as number | null) ?? null,
        axis_clarity: (r.axis_clarity as number | null) ?? null,
        axis_natural_flow: (r.axis_natural_flow as number | null) ?? null,
        judge_model: (r.judge_model as string | null) ?? null,
      });
    }
    if (data.length < PAGE) break;
  }

  // Campaign meta for the distinct campaign ids (chunked .in()).
  const campaignIds = [...new Set(rows.map((r) => r.campaign_id).filter((x): x is string => !!x))];
  const campaignMeta = new Map<string, CampaignMeta>();
  for (let i = 0; i < campaignIds.length; i += 500) {
    const { data, error } = await supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, base_assistant_id, is_test")
      .in("id", campaignIds.slice(i, i + 500));
    if (error) throw error;
    for (const c of (data ?? []) as Array<Record<string, unknown>>) {
      campaignMeta.set(c.id as string, {
        baseAssistantId: (c.base_assistant_id as string | null) ?? null,
        name: (c.name as string | null) ?? (c.id as string),
        isTest: c.is_test === true,
      });
    }
  }

  // One population for all three sections: real (non-test) traffic. A row whose
  // campaign is unknown/null can't be proven test → kept (lands in "unattributed").
  const isTest = (r: ScoreRow) => !!(r.campaign_id && campaignMeta.get(r.campaign_id)?.isTest);
  const nonTest = rows.filter((r) => !isTest(r));

  const verdictMix = computeVerdictMix(nonTest.map((r) => r.success_verdict));

  // Drill-down refs: true CALL timestamps for the failure rows (qa_scores.created_at is
  // the scoring time — the initial backfill scored weeks-old calls, so it would mislead).
  // calls_v2 is read for id + created_at ONLY (no PII columns). Bounded by failure count.
  const failureRows = nonTest.filter((r) => r.success_verdict === "failure");
  const calledAt = new Map<string, string>();
  const failureCallIds = [...new Set(failureRows.map((r) => r.call_id).filter(Boolean))];
  // Chunk of 200, NOT 500: PostgREST echoes the .in() query back in the Content-Location
  // response header, and ~390+ uuids blows undici's 16KB response-header cap (reproduced
  // live) → the throw would 500 the whole panel. failureCallIds grows with failure traffic.
  for (let i = 0; i < failureCallIds.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from("calls_v2")
      .select("id, created_at")
      .in("id", failureCallIds.slice(i, i + 200));
    if (error) throw error;
    for (const c of (data ?? []) as Array<Record<string, unknown>>) {
      if (c.id && c.created_at) calledAt.set(c.id as string, c.created_at as string);
    }
  }
  const failureThemes = topFailureThemes(
    failureRows.map((r) => ({
      callId: r.call_id,
      campaignId: r.campaign_id,
      campaignName: r.campaign_id ? (campaignMeta.get(r.campaign_id)?.name ?? null) : null,
      calledAt: calledAt.get(r.call_id) ?? null,
      rationale: r.rationale ?? "",
    })),
  );

  const agents = rollupByBaseAgent(nonTest, campaignMeta);
  const resolvedToBase = nonTest.filter((r) => r.campaign_id && campaignMeta.get(r.campaign_id)?.baseAssistantId).length;
  const judgeModel = rows.find((r) => r.judge_model)?.judge_model ?? null;

  return {
    verdictMix,
    failureThemes,
    agents,
    meta: {
      totalScores: rows.length,
      nonTestScores: nonTest.length,
      excludedTestScores: rows.length - nonTest.length,
      resolvedToBase,
      judgeModel,
      judgeVersion: jv,
    },
  };
}
