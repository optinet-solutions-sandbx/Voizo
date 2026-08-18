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

/**
 * The prompt's last-edited time — the freeze boundary. A call scored at/after this is
 * "current" (frozen, won't be re-scored); a call scored BEFORE it means the prompt has
 * been edited since, so it's eligible for re-scoring. Null if the prompt no longer exists
 * (then we fall back to freezing by prompt id alone). Editing a prompt bumps updated_at
 * via the set_updated_at trigger on listener_qa_prompts.
 */
async function promptUpdatedAt(promptId: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("listener_qa_prompts").select("updated_at").eq("id", promptId).maybeSingle();
  return (data?.updated_at as string | null) ?? null;
}

/**
 * Call ids already analyzed for this campaign with the CURRENT version of this prompt —
 * i.e. scored at/after the prompt's last edit. Re-running the same prompt freezes these
 * (they're skipped); editing the prompt makes older scores eligible again. Fully paged so
 * a campaign with >1000 scored calls doesn't silently drop rows (which would re-score them).
 */
async function analyzedCallIds(campaignId: string, promptId: string | null): Promise<Set<string>> {
  if (!promptId) return new Set();
  const since = await promptUpdatedAt(promptId);
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin
      .from("listener_qa_analysis_runs")
      .select("call_id")
      .eq("campaign_id", campaignId)
      .eq("prompt_id", promptId)
      .order("analyzed_at", { ascending: false })
      .range(from, from + 999);
    if (since) q = q.gte("analyzed_at", since);
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as Array<{ call_id: string }>;
    for (const r of page) ids.add(r.call_id);
    if (page.length < 1000) break;
  }
  return ids;
}

/**
 * Reached calls in a campaign NOT yet analyzed with this prompt (optionally capped).
 * `reanalyze` bypasses the freeze/dedup entirely — returns EVERY reached call so a new
 * or edited prompt can re-score calls that were already analyzed.
 */
export async function selectReachedUnanalyzedCalls(
  campaignId: string,
  promptId: string | null,
  limit?: number,
  reanalyze = false,
): Promise<ReachedCall[]> {
  const [calls, done] = await Promise.all([
    fetchReachedCalls(campaignId),
    reanalyze ? Promise.resolve(new Set<string>()) : analyzedCallIds(campaignId, promptId),
  ]);
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

/** Every batch job across all campaigns (newest first), each with its campaign name. */
export async function getAllBatchJobs(limit = 300): Promise<(QaBatchJob & { campaignName: string | null })[]> {
  const { data, error } = await supabaseAdmin
    .from("listener_qa_batch_jobs")
    .select(`${JOB_COLS}, campaigns_v2!campaign_id(name)`)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const camp = one(r.campaigns_v2);
    return { ...rowToJob(r), campaignName: (camp?.name as string) ?? null };
  });
}

// ── OpenAI polling (shared by the per-campaign + all-campaigns GET routes) ────
const POLL_ACTIVE = new Set(["validating", "in_progress", "finalizing"]);
const OPENAI_STATUS_MAP: Record<string, string> = {
  validating: "validating",
  in_progress: "in_progress",
  finalizing: "finalizing",
  completed: "completed",
  expired: "expired",
  cancelling: "cancelling",
  cancelled: "cancelled",
  failed: "failed",
};

/** Poll OpenAI for each still-active job, persist status/counts, and mutate the
 *  passed job objects in place so the caller can return the fresh view. */
export async function pollActiveJobs(jobs: QaBatchJob[], apiKey: string): Promise<void> {
  await Promise.all(
    jobs
      .filter((j) => j.openaiBatchId && POLL_ACTIVE.has(j.status))
      .map(async (job) => {
        try {
          const res = await fetch(`https://api.openai.com/v1/batches/${job.openaiBatchId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (!res.ok) return;
          const b = await res.json();
          const status = OPENAI_STATUS_MAP[b.status] ?? "in_progress";
          const counts = b.request_counts ?? {};
          const patch: Record<string, unknown> = {
            status,
            completed_conversations: counts.completed ?? job.completedConversations,
            failed_conversations: counts.failed ?? job.failedConversations,
          };
          if (status === "completed") {
            patch.output_file_id = b.output_file_id ?? null;
            patch.completed_at = new Date().toISOString();
          }
          if (status === "failed" || status === "expired") {
            patch.error_message = b.errors?.data?.[0]?.message ?? status;
          }
          await updateBatchJob(job.id, patch);
          job.status = status;
          job.outputFileId = (patch.output_file_id as string) ?? job.outputFileId;
          job.completedConversations = patch.completed_conversations as number;
          job.failedConversations = patch.failed_conversations as number;
        } catch {
          /* transient — leave the job as-is this tick */
        }
      }),
  );
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
  scoredBy?: string | null; // model that produced `summary` (gpt-5.4-mini | gpt-5.4)
}

/** Idempotent per (call_id, batch_job_id) — re-importing a job overwrites in place. */
export async function upsertAnalysisRuns(rows: AnalysisRunInsert[]): Promise<void> {
  if (rows.length === 0) return;
  const full: Record<string, unknown>[] = rows.map((r) => ({
    call_id: r.callId,
    campaign_id: r.campaignId,
    prompt_id: r.promptId,
    prompt_title: r.promptTitle,
    prompt_content: r.promptContent,
    summary: r.summary,
    batch_job_id: r.batchJobId,
    analyzed_at: r.analyzedAt,
    scored_by: r.scoredBy ?? null,
  }));
  let { error } = await supabaseAdmin.from("listener_qa_analysis_runs").upsert(full, { onConflict: "call_id,batch_job_id" });
  if (error && (error.code === "PGRST204" || /scored_by/i.test(error.message || ""))) {
    // supabase-migration-qa-scored-by.sql not applied yet — retry without the column.
    const stripped = full.map((row) => {
      const copy = { ...row };
      delete copy.scored_by;
      return copy;
    });
    ({ error } = await supabaseAdmin.from("listener_qa_analysis_runs").upsert(stripped, { onConflict: "call_id,batch_job_id" }));
  }
  if (error) throw error;
}

export interface AnalysisRunListItem {
  id: string;
  callId: string;
  campaignId: string;
  campaignName: string | null;
  campaignTimezone: string;
  promptTitle: string | null;
  analyzedAt: string;
  summary: string | null;
  scoredBy: string | null;
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

/**
 * Whether listener_qa_analysis_runs.scored_by exists yet (supabase-migration-qa-scored-by.sql).
 * Probed fresh per call (no cache) so reads self-heal the moment the migration is applied,
 * and never 500 in the gap between deploy and migration.
 */
async function hasScoredBy(): Promise<boolean> {
  const { error } = await supabaseAdmin.from("listener_qa_analysis_runs").select("scored_by").limit(1);
  return !error;
}

/** Strip ```json fences before JSON.parse of a stored result. */
function stripFences(s: string): string {
  return s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
}
/** Parse a stored result's call_attempt + reached_category (empty when absent; parsed=false on non-JSON). */
export function parseCategories(summary: string | null): { callAttempt: string; reachedCategory: string; parsed: boolean } {
  try {
    const o = JSON.parse(stripFences(summary ?? "")) as Record<string, unknown>;
    return {
      callAttempt: typeof o.call_attempt === "string" ? o.call_attempt.trim() : "",
      reachedCategory: typeof o.reached_category === "string" ? o.reached_category.trim() : "",
      parsed: true,
    };
  } catch {
    return { callAttempt: "", reachedCategory: "", parsed: false };
  }
}

// The campaigns_v2 default timezone — used when a campaign has none set. Val's concern:
// a campaign only calls ~10h/day in its OWN timezone, so a "day" must be the campaign-local
// calendar date, not the viewer's. We derive it from the UTC created_at + campaign timezone
// (the same IANA zone the dialer's call-window gate uses), so AU/CA days line up correctly.
export const DEFAULT_QA_TZ = "America/Toronto";
const _tzFmt = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = _tzFmt.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_QA_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    }
    _tzFmt.set(tz, f);
  }
  return f;
}
/** The local calendar date (YYYY-MM-DD) of a UTC instant in the given IANA timezone. */
export function localDateInTz(iso: string, tz: string): string {
  const parts = tzFormatter(tz || DEFAULT_QA_TZ).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * Analysis history / drill-down list. All filters optional: campaign, call-date
 * window [fromMs, toMs), and call_attempt / reached_category (parsed from the stored
 * result). Pages fully so the window/category filters aren't truncated by the row cap.
 */
export async function listAnalysisRuns(opts: {
  campaignId?: string;
  limit?: number;
  fromMs?: number | null;
  toMs?: number | null;
  day?: string | null;
  callAttempt?: string;
  reachedCategory?: string;
  latestPerCall?: boolean;
  promptId?: string | null;
} = {}): Promise<AnalysisRunListItem[]> {
  // Only the filtered drill-down needs a full page-through; the plain history list
  // (newest-first, no window/category filter) can stop after it has `limit` rows.
  const wantAll = opts.fromMs != null || opts.toMs != null || opts.day != null || opts.latestPerCall === true || !!opts.callAttempt || !!opts.reachedCategory || !!opts.promptId;
  const scoredByCol = (await hasScoredBy()) ? ", scored_by" : "";
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 12000; from += 1000) {
    let q = supabaseAdmin
      .from("listener_qa_analysis_runs")
      .select(
        "id, call_id, campaign_id, prompt_title, summary, analyzed_at" + scoredByCol + ", " +
          "campaigns_v2!campaign_id(name, timezone), " +
          "calls_v2!call_id(created_at, duration_seconds, goal_reached, campaign_numbers_v2!campaign_number_id(phone_e164, display_name))",
      )
      .order("analyzed_at", { ascending: false })
      .range(from, from + 999);
    if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
    if (opts.promptId) q = q.eq("prompt_id", opts.promptId);
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < 1000) break;
    if (!wantAll && rows.length >= (opts.limit ?? 500)) break;
  }
  let items: AnalysisRunListItem[] = rows.map((r) => {
    const camp = one(r.campaigns_v2);
    const call = one(r.calls_v2);
    const cust = call ? one(call.campaign_numbers_v2) : null;
    return {
      id: r.id as string,
      callId: r.call_id as string,
      campaignId: r.campaign_id as string,
      campaignName: (camp?.name as string) ?? null,
      campaignTimezone: (camp?.timezone as string) || DEFAULT_QA_TZ,
      promptTitle: (r.prompt_title as string | null) ?? null,
      analyzedAt: r.analyzed_at as string,
      summary: (r.summary as string | null) ?? null,
      scoredBy: (r.scored_by as string | null) ?? null,
      customerPhone: (cust?.phone_e164 as string) ?? null,
      customerName: (cust?.display_name as string) ?? null,
      callCreatedAt: (call?.created_at as string) ?? null,
      durationSeconds: (call?.duration_seconds as number | null) ?? null,
      goalReached: (call?.goal_reached as boolean | null) ?? null,
    };
  });
  // Dedup to the latest run per call (rows are newest-first) BEFORE category filtering,
  // so the drill-down matches the dashboard's "latest prompt wins" counts.
  if (opts.latestPerCall) {
    const seen = new Set<string>();
    items = items.filter((it) => {
      if (seen.has(it.callId)) return false;
      seen.add(it.callId);
      return true;
    });
  }
  if (opts.day != null) {
    // Campaign-local day match (each run in its own campaign's timezone).
    items = items.filter((it) => it.callCreatedAt != null && localDateInTz(it.callCreatedAt, it.campaignTimezone) === opts.day);
  } else if (opts.fromMs != null || opts.toMs != null) {
    items = items.filter((it) => {
      if (!it.callCreatedAt) return false;
      const t = new Date(it.callCreatedAt).getTime();
      if (opts.fromMs != null && t < opts.fromMs) return false;
      if (opts.toMs != null && t >= opts.toMs) return false;
      return true;
    });
  }
  if (opts.callAttempt || opts.reachedCategory) {
    items = items.filter((it) => {
      const c = parseCategories(it.summary);
      if (opts.callAttempt && c.callAttempt !== opts.callAttempt) return false;
      if (opts.reachedCategory && c.reachedCategory !== opts.reachedCategory) return false;
      return true;
    });
  }
  return opts.limit && opts.limit > 0 ? items.slice(0, opts.limit) : items;
}

export interface AnalysisRunRow {
  id: string;
  callId: string;
  campaignId: string;
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  summary: string | null;
  scoredBy: string | null;
  analyzedAt: string;
}

/** One run's stored prompt + result (for the run-detail replay). */
export async function getAnalysisRun(id: string): Promise<AnalysisRunRow | null> {
  const scoredByCol = (await hasScoredBy()) ? ", scored_by" : "";
  const { data, error } = await supabaseAdmin
    .from("listener_qa_analysis_runs")
    .select("id, call_id, campaign_id, prompt_id, prompt_title, prompt_content, summary, analyzed_at" + scoredByCol)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const r = data as unknown as Record<string, unknown>;
  return {
    id: r.id as string,
    callId: r.call_id as string,
    campaignId: r.campaign_id as string,
    promptId: (r.prompt_id as string | null) ?? null,
    promptTitle: (r.prompt_title as string | null) ?? null,
    promptContent: (r.prompt_content as string) ?? "",
    summary: (r.summary as string | null) ?? null,
    scoredBy: (r.scored_by as string | null) ?? null,
    analyzedAt: r.analyzed_at as string,
  };
}

// ── QA Analysis dashboard aggregation ─────────────────────────────────────────
// A READ-ONLY roll-up of listener_qa_analysis_runs for the temporary QA dashboard.
// Completely isolated from the campaigns dashboard (which reads calls_v2 + the SQL
// rollups) — this only parses stored prompt results. Buckets by the model's schema:
// call_attempt (Reached / Voicemail / Unreachable / …) and reached_category
// (Positive / Neutral / Declined / Early Hang-up / Agent Timeout).

export interface QaDashboardCampaign {
  campaignId: string;
  campaignName: string | null;
  timezone: string;
  lastAnalyzedAt: string | null;
  total: number;
  callAttempt: Record<string, number>;
  reachedCategory: Record<string, number>;
  smsSent: number; // SMS follow-ups (status sent/delivered) sent for this campaign's in-scope calls
}
export interface QaDashboardData {
  total: number;
  unparseable: number;
  doubleChecked: number; // calls whose stored verdict came from the gpt-5.4 double-check
  smsSent: number; // total SMS follow-ups (sent/delivered) for the in-scope calls
  callAttempts: number; // every dial in-window (metadata, excl ghost/test) — matches the MAIN dashboard
  byCallAttempt: Record<string, number>;
  byReachedCategory: Record<string, number>;
  campaigns: QaDashboardCampaign[];
}

/**
 * Roll-up of the QA analysis results. Scope is EITHER a single campaign-local `day`
 * (YYYY-MM-DD — each run bucketed in ITS campaign's timezone) OR a UTC [fromMs,toMs)
 * range; `day` wins when both are given. `day` is the daily/yesterday snapshot Val asked
 * for, correct across AU/CA. Campaign name + timezone come from the embedded join.
 *
 * DEDUP: a call re-analyzed under several prompts has several rows; we count each call
 * ONCE using its LATEST run (rows come newest-first, so first-seen per call_id wins).
 * "Latest prompt takes precedence" — otherwise near-identical re-runs double-count and
 * confuse the totals. `lastAnalyzedAt` per campaign is that latest run's time.
 *
 * `promptId` restricts to a single prompt's results (for prompt-vs-prompt comparison);
 * the call is then counted once using its latest run FOR THAT PROMPT. Omit for the
 * combined view (latest run per call across all prompts).
 */
export async function getQaAnalysisDashboard(
  opts: { fromMs?: number | null; toMs?: number | null; day?: string | null; promptId?: string | null } = {},
): Promise<QaDashboardData> {
  const scoredByCol = (await hasScoredBy()) ? ", scored_by" : "";
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; from < 12000; from += 1000) {
    let q = supabaseAdmin
      .from("listener_qa_analysis_runs")
      .select("call_id, campaign_id, summary, analyzed_at" + scoredByCol + ", calls_v2!call_id(created_at), campaigns_v2!campaign_id(name, timezone)")
      .order("analyzed_at", { ascending: false })
      .range(from, from + 999);
    if (opts.promptId) q = q.eq("prompt_id", opts.promptId);
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as unknown as Array<Record<string, unknown>>;
    rows.push(...page);
    if (page.length < 1000) break;
  }

  const matches = (createdAt: string | undefined, tz: string): boolean => {
    if (opts.day != null) {
      if (!createdAt) return false;
      return localDateInTz(createdAt, tz) === opts.day;
    }
    if (opts.fromMs == null && opts.toMs == null) return true;
    if (!createdAt) return false;
    const t = new Date(createdAt).getTime();
    if (opts.fromMs != null && t < opts.fromMs) return false;
    if (opts.toMs != null && t >= opts.toMs) return false;
    return true;
  };

  const byCallAttempt: Record<string, number> = {};
  const byReachedCategory: Record<string, number> = {};
  const perC = new Map<string, QaDashboardCampaign>();
  const seenCalls = new Set<string>();
  let unparseable = 0;
  let total = 0;
  let doubleChecked = 0;

  for (const r of rows) {
    const callId = r.call_id as string;
    if (seenCalls.has(callId)) continue; // older re-run of a call already counted
    const camp = one(r.campaigns_v2);
    const tz = (camp?.timezone as string) || DEFAULT_QA_TZ;
    const createdAt = one(r.calls_v2)?.created_at as string | undefined;
    if (!matches(createdAt, tz)) continue; // window is call-level, identical for every run of this call
    seenCalls.add(callId);
    total += 1;
    if (r.scored_by === "gpt-5.4") doubleChecked += 1;
    const p = parseCategories(r.summary as string | null);
    if (!p.parsed) unparseable += 1;
    const attempt = p.callAttempt || (p.parsed ? "Unclassified" : "Unparseable");
    const category = p.reachedCategory;
    byCallAttempt[attempt] = (byCallAttempt[attempt] ?? 0) + 1;
    if (category) byReachedCategory[category] = (byReachedCategory[category] ?? 0) + 1;

    const cid = r.campaign_id as string;
    let c = perC.get(cid);
    if (!c) {
      // First row for this campaign (newest-first) → its latest analyzed_at.
      c = { campaignId: cid, campaignName: (camp?.name as string) ?? null, timezone: tz, lastAnalyzedAt: (r.analyzed_at as string) ?? null, total: 0, callAttempt: {}, reachedCategory: {}, smsSent: 0 };
      perC.set(cid, c);
    }
    c.total += 1;
    c.callAttempt[attempt] = (c.callAttempt[attempt] ?? 0) + 1;
    if (category) c.reachedCategory[category] = (c.reachedCategory[category] ?? 0) + 1;
  }

  // SMS follow-ups sent for exactly these in-scope calls (same window/timezone logic —
  // we scope by the call ids we counted, not by SMS date, so it can't drift out of the
  // period). Count messages that reached the provider (sent) or the handset (delivered);
  // undelivered/failed don't count. Non-fatal: a failure here leaves smsSent at 0.
  let smsSent = 0;
  const inScopeCallIds = [...seenCalls];
  try {
    for (let i = 0; i < inScopeCallIds.length; i += 300) {
      const slice = inScopeCallIds.slice(i, i + 300);
      const { data: smsRows, error: smsErr } = await supabaseAdmin
        .from("sms_messages_v2")
        .select("call_id, campaign_id")
        .in("call_id", slice)
        .in("status", ["sent", "delivered"]);
      if (smsErr) throw smsErr;
      for (const s of smsRows ?? []) {
        smsSent += 1;
        const c = perC.get(s.campaign_id as string);
        if (c) c.smsSent += 1;
      }
    }
  } catch (e) {
    console.error("[getQaAnalysisDashboard] SMS count failed (non-fatal):", e);
  }

  // Call attempts for the SAME window, sourced like the MAIN dashboard (every dial,
  // excluding ghost + test campaigns) so the Call Attempts number tallies with the
  // campaigns dashboard. Metadata only — independent of the AI analysis above.
  let callAttempts = 0;
  try {
    const { data: campMeta } = await supabaseAdmin.from("campaigns_v2").select("id, timezone, source, is_test");
    const excludedIds: string[] = [];
    const tzById = new Map<string, string>();
    for (const c of (campMeta ?? []) as Array<Record<string, unknown>>) {
      tzById.set(c.id as string, (c.timezone as string) || DEFAULT_QA_TZ);
      if (c.source === "ghost_portal" || c.is_test === true) excludedIds.push(c.id as string);
    }
    if (opts.day == null) {
      // Range / all-time: pure created_at window → count queries (no row scan).
      const rangeCount = async (onlyExcluded: boolean): Promise<number> => {
        let q = supabaseAdmin.from("calls_v2").select("*", { count: "exact", head: true });
        if (opts.fromMs != null) q = q.gte("created_at", new Date(opts.fromMs).toISOString());
        if (opts.toMs != null) q = q.lt("created_at", new Date(opts.toMs).toISOString());
        if (onlyExcluded) q = q.in("campaign_id", excludedIds);
        const { count } = await q;
        return count ?? 0;
      };
      const totalAttempts = await rangeCount(false);
      const excludedAttempts = excludedIds.length ? await rangeCount(true) : 0;
      callAttempts = totalAttempts - excludedAttempts;
    } else {
      // Single campaign-local day → coarse +/-1-day fetch, then exact timezone bucketing.
      const dayStart = new Date(opts.day + "T00:00:00Z").getTime();
      const lo = new Date(dayStart - 86_400_000).toISOString();
      const hi = new Date(dayStart + 2 * 86_400_000).toISOString();
      const excludedSet = new Set(excludedIds);
      for (let f = 0; ; f += 1000) {
        const { data, error } = await supabaseAdmin
          .from("calls_v2").select("campaign_id, created_at")
          .gte("created_at", lo).lt("created_at", hi).range(f, f + 999);
        if (error) throw error;
        const pg = (data ?? []) as Array<Record<string, unknown>>;
        for (const c of pg) {
          const cid = c.campaign_id as string;
          if (excludedSet.has(cid)) continue;
          if (localDateInTz(c.created_at as string, tzById.get(cid) || DEFAULT_QA_TZ) === opts.day) callAttempts += 1;
        }
        if (pg.length < 1000) break;
      }
    }
  } catch (e) {
    console.error("[getQaAnalysisDashboard] callAttempts failed (non-fatal):", e);
  }

  return {
    total,
    unparseable,
    doubleChecked,
    smsSent,
    callAttempts,
    byCallAttempt,
    byReachedCategory,
    campaigns: [...perC.values()].sort((a, b) => b.total - a.total),
  };
}

// ── Cross-campaign selection (all-campaigns manual run + daily cron) ───────────
/**
 * Every reached call (person or voicemail, with a transcript) across ALL non-ghost
 * campaigns in the [fromMs,toMs) call-date window, NOT yet analyzed with this prompt,
 * grouped by campaign. The window is applied in SQL; ghost + already-analyzed excluded.
 */
export async function selectReachedUnanalyzedAcrossCampaigns(opts: {
  promptId: string;
  fromMs?: number | null;
  toMs?: number | null;
  reanalyze?: boolean;
}): Promise<Map<string, ReachedCall[]>> {
  const rows: Array<{ id: string; campaign_id: string; transcript: unknown }> = [];
  for (let from = 0; ; from += 1000) {
    let q = supabaseAdmin
      .from("calls_v2")
      .select("id, campaign_id, transcript")
      .in("status", CONNECTED_STATUSES as unknown as string[])
      .not("transcript", "is", null)
      .order("created_at", { ascending: false })
      .range(from, from + 999);
    if (opts.fromMs != null) q = q.gte("created_at", new Date(opts.fromMs).toISOString());
    if (opts.toMs != null) q = q.lt("created_at", new Date(opts.toMs).toISOString());
    const { data, error } = await q;
    if (error) throw error;
    const page = (data ?? []) as Array<{ id: string; campaign_id: string; transcript: unknown }>;
    rows.push(...page);
    if (page.length < 1000) break;
  }

  const ghost = new Set<string>();
  const { data: camps } = await supabaseAdmin.from("campaigns_v2").select("id, source");
  for (const c of (camps ?? []) as Array<{ id: string; source: string | null }>) {
    if (c.source === "ghost_portal") ghost.add(c.id);
  }

  // Frozen = already scored with the CURRENT prompt version (at/after its last edit).
  // Paged fully so >1000 scored calls aren't silently dropped (which would re-score them).
  // `reanalyze` skips this entirely, so every reached call is (re-)scored.
  const analyzed = new Set<string>();
  if (!opts.reanalyze) {
    const since = await promptUpdatedAt(opts.promptId);
    for (let from = 0; ; from += 1000) {
      let rq = supabaseAdmin
        .from("listener_qa_analysis_runs")
        .select("call_id")
        .eq("prompt_id", opts.promptId)
        .order("analyzed_at", { ascending: false })
        .range(from, from + 999);
      if (since) rq = rq.gte("analyzed_at", since);
      const { data: runs, error: runsErr } = await rq;
      if (runsErr) throw runsErr;
      const page = (runs ?? []) as Array<{ call_id: string }>;
      for (const r of page) analyzed.add(r.call_id);
      if (page.length < 1000) break;
    }
  }

  const map = new Map<string, ReachedCall[]>();
  for (const r of rows) {
    if (ghost.has(r.campaign_id) || analyzed.has(r.id)) continue;
    const t = transcriptText(r.transcript);
    if (!t.trim()) continue;
    if (!map.has(r.campaign_id)) map.set(r.campaign_id, []);
    map.get(r.campaign_id)!.push({ id: r.id, transcript: t });
  }
  return map;
}

// ── Daily-analysis schedule (singleton config) ────────────────────────────────
export interface QaSchedule {
  enabled: boolean;
  promptId: string | null;
  lastRunAt: string | null;
  lastRunSummary: string | null;
}

export async function getQaSchedule(): Promise<QaSchedule> {
  const { data, error } = await supabaseAdmin
    .from("listener_qa_schedule")
    .select("enabled, prompt_id, last_run_at, last_run_summary")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw error;
  return {
    enabled: Boolean(data?.enabled),
    promptId: (data?.prompt_id as string | null) ?? null,
    lastRunAt: (data?.last_run_at as string | null) ?? null,
    lastRunSummary: (data?.last_run_summary as string | null) ?? null,
  };
}

export async function setQaSchedule(patch: {
  enabled?: boolean;
  promptId?: string | null;
  lastRunAt?: string;
  lastRunSummary?: string;
}): Promise<void> {
  const upd: Record<string, unknown> = { id: "default" };
  if (patch.enabled !== undefined) upd.enabled = patch.enabled;
  if (patch.promptId !== undefined) upd.prompt_id = patch.promptId;
  if (patch.lastRunAt !== undefined) upd.last_run_at = patch.lastRunAt;
  if (patch.lastRunSummary !== undefined) upd.last_run_summary = patch.lastRunSummary;
  const { error } = await supabaseAdmin.from("listener_qa_schedule").upsert(upd, { onConflict: "id" });
  if (error) throw error;
}
