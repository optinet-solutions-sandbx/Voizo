// src/lib/qaBatchData.ts
//
// Data layer for QA bulk (batch) analysis + analysis history. Service-role only
// (both tables are default-deny — see supabase-migration-qa-batch.sql). Keep all
// access behind /api/qa-prompt-testing/*.
import { supabaseAdmin } from "./supabaseServer";
import { transcriptText } from "./labelData";

// "Reached" = the call connected to a live person OR voicemail. calls_v2.status is
// 'completed' | 'answered' for connected calls (voicemail is a subset, flagged
// separately); no-answer / failed / canceled are excluded. Only calls that also
// have a transcript can be scored.
const CONNECTED_STATUSES = ["completed", "answered"] as const;

export interface QaBatchJob {
  id: string;
  campaignId: string;
  openaiBatchId: string | null;
  openaiFileId: string | null;
  outputFileId: string | null;
  status: string;
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  chunkIndex: number;
  totalChunks: number;
  totalConversations: number;
  completedConversations: number;
  failedConversations: number;
  importedCount: number;
  errorMessage: string | null;
  createdAt: string;
  submittedAt: string | null;
  completedAt: string | null;
}

const JOB_COLS =
  "id, campaign_id, openai_batch_id, openai_file_id, output_file_id, status, prompt_id, prompt_title, prompt_content, chunk_index, total_chunks, total_conversations, completed_conversations, failed_conversations, imported_count, error_message, created_at, submitted_at, completed_at";

function rowToJob(r: Record<string, unknown>): QaBatchJob {
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    openaiBatchId: (r.openai_batch_id as string | null) ?? null,
    openaiFileId: (r.openai_file_id as string | null) ?? null,
    outputFileId: (r.output_file_id as string | null) ?? null,
    status: (r.status as string) ?? "pending",
    promptId: (r.prompt_id as string | null) ?? null,
    promptTitle: (r.prompt_title as string | null) ?? null,
    promptContent: (r.prompt_content as string) ?? "",
    chunkIndex: (r.chunk_index as number) ?? 0,
    totalChunks: (r.total_chunks as number) ?? 1,
    totalConversations: (r.total_conversations as number) ?? 0,
    completedConversations: (r.completed_conversations as number) ?? 0,
    failedConversations: (r.failed_conversations as number) ?? 0,
    importedCount: (r.imported_count as number) ?? 0,
    errorMessage: (r.error_message as string | null) ?? null,
    createdAt: r.created_at as string,
    submittedAt: (r.submitted_at as string | null) ?? null,
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

// ── Target-call selection ─────────────────────────────────────────────────────

export interface ReachedCall {
  id: string;
  transcript: string;
}

/** Every reached call in a campaign that has a usable transcript (paged, scoped). */
async function fetchReachedCalls(campaignId: string): Promise<ReachedCall[]> {
  const out: ReachedCall[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("calls_v2")
      .select("id, transcript")
      .eq("campaign_id", campaignId)
      .in("status", CONNECTED_STATUSES as unknown as string[])
      .not("transcript", "is", null)
      .order("created_at", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; transcript: unknown }>;
    for (const r of rows) {
      const t = transcriptText(r.transcript);
      if (t.trim()) out.push({ id: r.id, transcript: t });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/** Call ids already analyzed for this campaign + prompt (so re-submit is safe). */
async function analyzedCallIds(campaignId: string, promptId: string | null): Promise<Set<string>> {
  if (!promptId) return new Set();
  const ids = new Set<string>();
  const { data, error } = await supabaseAdmin
    .from("listener_qa_analysis_runs")
    .select("call_id")
    .eq("campaign_id", campaignId)
    .eq("prompt_id", promptId);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{ call_id: string }>) ids.add(r.call_id);
  return ids;
}

/** Reached calls in a campaign NOT yet analyzed with this prompt (optionally capped). */
export async function selectReachedUnanalyzedCalls(
  campaignId: string,
  promptId: string | null,
  limit?: number,
): Promise<ReachedCall[]> {
  const [calls, done] = await Promise.all([fetchReachedCalls(campaignId), analyzedCallIds(campaignId, promptId)]);
  let pending = calls.filter((c) => !done.has(c.id));
  if (limit && limit > 0) pending = pending.slice(0, limit);
  return pending;
}

/** Totals for the submit card: reached calls with transcripts, and how many remain. */
export async function reachedCounts(
  campaignId: string,
  promptId: string | null,
): Promise<{ reached: number; unanalyzed: number }> {
  const [calls, done] = await Promise.all([fetchReachedCalls(campaignId), analyzedCallIds(campaignId, promptId)]);
  return { reached: calls.length, unanalyzed: calls.filter((c) => !done.has(c.id)).length };
}

// ── Batch job CRUD ────────────────────────────────────────────────────────────

export async function insertBatchJob(input: {
  campaignId: string;
  openaiBatchId: string | null;
  openaiFileId: string | null;
  status: string;
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  chunkIndex: number;
  totalChunks: number;
  totalConversations: number;
  failedConversations?: number;
  errorMessage?: string | null;
  submittedAt: string | null;
}): Promise<QaBatchJob> {
  const { data, error } = await supabaseAdmin
    .from("listener_qa_batch_jobs")
    .insert({
      campaign_id: input.campaignId,
      openai_batch_id: input.openaiBatchId,
      openai_file_id: input.openaiFileId,
      status: input.status,
      prompt_id: input.promptId,
      prompt_title: input.promptTitle,
      prompt_content: input.promptContent,
      chunk_index: input.chunkIndex,
      total_chunks: input.totalChunks,
      total_conversations: input.totalConversations,
      failed_conversations: input.failedConversations ?? 0,
      error_message: input.errorMessage ?? null,
      submitted_at: input.submittedAt,
    })
    .select(JOB_COLS)
    .single();
  if (error || !data) throw error ?? new Error("Insert batch job failed");
  return rowToJob(data as Record<string, unknown>);
}

export async function updateBatchJob(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from("listener_qa_batch_jobs").update(patch).eq("id", id);
  if (error) throw error;
}

export async function getBatchJobs(campaignId: string): Promise<QaBatchJob[]> {
  const { data, error } = await supabaseAdmin
    .from("listener_qa_batch_jobs")
    .select(JOB_COLS)
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => rowToJob(r as Record<string, unknown>));
}

export async function getBatchJobById(id: string): Promise<QaBatchJob | null> {
  const { data, error } = await supabaseAdmin.from("listener_qa_batch_jobs").select(JOB_COLS).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? rowToJob(data as Record<string, unknown>) : null;
}

// ── Analysis runs ───────────────────────────────────────────────────────────

export interface AnalysisRunInsert {
  callId: string;
  campaignId: string;
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  summary: string;
  batchJobId: string;
  analyzedAt: string;
}

/** Idempotent per (call_id, batch_job_id) — re-importing a job overwrites in place. */
export async function upsertAnalysisRuns(rows: AnalysisRunInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from("listener_qa_analysis_runs").upsert(
    rows.map((r) => ({
      call_id: r.callId,
      campaign_id: r.campaignId,
      prompt_id: r.promptId,
      prompt_title: r.promptTitle,
      prompt_content: r.promptContent,
      summary: r.summary,
      batch_job_id: r.batchJobId,
      analyzed_at: r.analyzedAt,
    })),
    { onConflict: "call_id,batch_job_id" },
  );
  if (error) throw error;
}

export interface AnalysisRunListItem {
  id: string;
  callId: string;
  campaignId: string;
  campaignName: string | null;
  promptTitle: string | null;
  analyzedAt: string;
  summary: string | null;
  customerPhone: string | null;
  customerName: string | null;
  callCreatedAt: string | null;
  durationSeconds: number | null;
  goalReached: boolean | null;
}

function one(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? null;
  return (v as Record<string, unknown>) ?? null;
}

/** Analysis history list — newest first, optionally scoped to one campaign. */
export async function listAnalysisRuns(opts: { campaignId?: string; limit?: number }): Promise<AnalysisRunListItem[]> {
  let q = supabaseAdmin
    .from("listener_qa_analysis_runs")
    .select(
      "id, call_id, campaign_id, prompt_title, summary, analyzed_at, " +
        "campaigns_v2!campaign_id(name), " +
        "calls_v2!call_id(created_at, duration_seconds, goal_reached, campaign_numbers_v2!campaign_number_id(phone_e164, display_name))",
    )
    .order("analyzed_at", { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const camp = one(r.campaigns_v2);
    const call = one(r.calls_v2);
    const cust = call ? one(call.campaign_numbers_v2) : null;
    return {
      id: r.id as string,
      callId: r.call_id as string,
      campaignId: r.campaign_id as string,
      campaignName: (camp?.name as string) ?? null,
      promptTitle: (r.prompt_title as string | null) ?? null,
      analyzedAt: r.analyzed_at as string,
      summary: (r.summary as string | null) ?? null,
      customerPhone: (cust?.phone_e164 as string) ?? null,
      customerName: (cust?.display_name as string) ?? null,
      callCreatedAt: (call?.created_at as string) ?? null,
      durationSeconds: (call?.duration_seconds as number | null) ?? null,
      goalReached: (call?.goal_reached as boolean | null) ?? null,
    };
  });
}

export interface AnalysisRunRow {
  id: string;
  callId: string;
  campaignId: string;
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  summary: string | null;
  analyzedAt: string;
}

/** One run's stored prompt + result (for the run-detail replay). */
export async function getAnalysisRun(id: string): Promise<AnalysisRunRow | null> {
  const { data, error } = await supabaseAdmin
    .from("listener_qa_analysis_runs")
    .select("id, call_id, campaign_id, prompt_id, prompt_title, prompt_content, summary, analyzed_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as Record<string, unknown>;
  return {
    id: r.id as string,
    callId: r.call_id as string,
    campaignId: r.campaign_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    promptTitle: (r.prompt_title as string | null) ?? null,
    promptContent: (r.prompt_content as string) ?? "",
    summary: (r.summary as string | null) ?? null,
    analyzedAt: r.analyzed_at as string,
  };
}
