import { NextRequest, NextResponse } from "next/server";
import {
  selectReachedUnanalyzedCalls,
  insertBatchJob,
  updateBatchJob,
  getBatchJobs,
  getBatchJobById,
  upsertAnalysisRuns,
  pollActiveJobs,
  type AnalysisRunInsert,
} from "@/lib/qaBatchData";
import { numberTranscript } from "@/lib/qaTranscript";

/**
 * /api/qa-prompt-testing/batch — per-campaign bulk analysis via the OpenAI Batch API.
 * A scoped replica of the ai-chat-qa-tool /batch-analysis flow:
 *   POST   submit  — build JSONL of reached, not-yet-analyzed calls -> upload -> create batch
 *   GET    status  — list this campaign's jobs, polling OpenAI for active ones
 *   PATCH  import  — download a completed batch's output -> upsert analysis runs (resume-safe)
 *   DELETE cancel  — cancel an active batch
 *
 * Targets only calls we reached (person or voicemail) that have a transcript. Matches the
 * single-call "Run QA" model + message shape so bulk and single results are comparable.
 */

export const maxDuration = 300;

const MODEL = "gpt-5.4-mini";
const MAX_REQUESTS_PER_CHUNK = 10_000; // per-campaign scale is small; one chunk in practice
const MAX_FILE_BYTES = 90 * 1024 * 1024;
const ACTIVE = new Set(["validating", "in_progress", "finalizing"]);

function crossOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

function jsonlLine(callId: string, transcript: string, promptContent: string): string {
  return JSON.stringify({
    custom_id: `call-${callId}`,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: MODEL,
      messages: [
        { role: "system", content: promptContent },
        { role: "user", content: `Score this call transcript:\n\n${numberTranscript(transcript)}` },
      ],
      max_completion_tokens: 4096,
      // Deterministic classification: at the default temperature (~1.0) a borderline
      // call flips Neutral <-> Early Hang-up between runs. temperature 0 + a fixed seed
      // make the same transcript score the same way every time.
      temperature: 0,
      seed: 7,
    },
  });
}

function chunkLines(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lb = Buffer.byteLength(line, "utf8") + 1;
    if (cur.length >= MAX_REQUESTS_PER_CHUNK || (cur.length > 0 && bytes + lb > MAX_FILE_BYTES)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(line);
    bytes += lb;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function uploadJsonl(lines: string[], fileName: string, apiKey: string): Promise<string> {
  const blob = new Blob([lines.join("\n")], { type: "application/jsonl" });
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", blob, fileName);
  const res = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI file upload failed: ${data.error?.message ?? res.status}`);
  return data.id as string;
}

async function createBatch(fileId: string, apiKey: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input_file_id: fileId, endpoint: "/v1/chat/completions", completion_window: "24h" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI batch create failed: ${data.error?.message ?? res.status}`);
  return data.id as string;
}

// ── POST: submit a batch for one campaign ─────────────────────────────────────
export async function POST(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  let body: { campaignId?: string; promptId?: string; promptTitle?: string; promptContent?: string; testLimit?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const campaignId = typeof body.campaignId === "string" ? body.campaignId : "";
  const promptContent = typeof body.promptContent === "string" ? body.promptContent : "";
  const promptId = typeof body.promptId === "string" ? body.promptId : null;
  const promptTitle = typeof body.promptTitle === "string" ? body.promptTitle : null;
  const testLimit = typeof body.testLimit === "number" && body.testLimit > 0 ? Math.floor(body.testLimit) : undefined;
  if (!campaignId) return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  if (!promptContent.trim()) return NextResponse.json({ error: "promptContent is required" }, { status: 400 });

  // Block if a batch is already active for this campaign (avoids duplicate submits).
  let jobs;
  try {
    jobs = await getBatchJobs(campaignId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to read jobs" }, { status: 500 });
  }
  if (jobs.some((j) => ACTIVE.has(j.status))) {
    return NextResponse.json(
      { error: "A batch is already in progress for this campaign. Wait for it to finish, then submit again." },
      { status: 429 },
    );
  }

  let calls;
  try {
    calls = await selectReachedUnanalyzedCalls(campaignId, promptId, testLimit);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to select calls" }, { status: 500 });
  }
  if (calls.length === 0) {
    return NextResponse.json({ message: "No reached, un-analyzed calls to submit for this prompt.", jobs: [] });
  }

  const lines = calls.map((c) => jsonlLine(c.id, c.transcript, promptContent));
  const chunks = chunkLines(lines);
  const now = new Date().toISOString();
  const created: string[] = [];
  let submitted = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const fileId = await uploadJsonl(chunk, `qa_batch_${campaignId}_${i}.jsonl`, apiKey);
      const batchId = await createBatch(fileId, apiKey);
      const job = await insertBatchJob({
        campaignId,
        openaiBatchId: batchId,
        openaiFileId: fileId,
        status: "validating",
        promptId,
        promptTitle,
        promptContent,
        chunkIndex: i,
        totalChunks: chunks.length,
        totalConversations: chunk.length,
        submittedAt: now,
      });
      created.push(job.id);
      submitted += chunk.length;
    } catch (e) {
      await insertBatchJob({
        campaignId,
        openaiBatchId: null,
        openaiFileId: null,
        status: "failed",
        promptId,
        promptTitle,
        promptContent,
        chunkIndex: i,
        totalChunks: chunks.length,
        totalConversations: chunk.length,
        failedConversations: chunk.length,
        errorMessage: e instanceof Error ? e.message : "submit failed",
        submittedAt: null,
      }).catch(() => {});
    }
  }

  return NextResponse.json({ totalConversations: calls.length, totalSubmitted: submitted, totalChunks: chunks.length, created: created.length });
}

// ── GET: list this campaign's jobs, polling OpenAI for active ones ────────────
export async function GET(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY;
  const campaignId = new URL(request.url).searchParams.get("campaignId") || "";
  if (!campaignId) return NextResponse.json({ error: "campaignId is required" }, { status: 400 });

  let jobs;
  try {
    jobs = await getBatchJobs(campaignId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to read jobs" }, { status: 500 });
  }

  if (apiKey) await pollActiveJobs(jobs, apiKey);

  return NextResponse.json({ jobs });
}

// ── PATCH: import a completed batch's output (resume-safe) ─────────────────────
export async function PATCH(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  let body: { batchJobId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const batchJobId = typeof body.batchJobId === "string" ? body.batchJobId : "";
  if (!batchJobId) return NextResponse.json({ error: "batchJobId is required" }, { status: 400 });

  const job = await getBatchJobById(batchJobId);
  if (!job) return NextResponse.json({ error: "Batch job not found" }, { status: 404 });
  if (job.status !== "completed") return NextResponse.json({ error: `Batch is not completed (status: ${job.status})` }, { status: 400 });
  if (!job.outputFileId) return NextResponse.json({ error: "No output file yet — refresh status first" }, { status: 400 });

  const outRes = await fetch(`https://api.openai.com/v1/files/${job.outputFileId}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!outRes.ok) return NextResponse.json({ error: `Failed to download output: ${outRes.status}` }, { status: 500 });
  const lines = (await outRes.text()).split("\n").filter((l) => l.trim().length > 0);

  const startAt = job.importedCount ?? 0;
  const now = new Date().toISOString();
  let imported = startAt;
  let failed = 0;
  const BATCH = 100;
  let buf: AnalysisRunInsert[] = [];

  const flush = async () => {
    if (buf.length === 0) return;
    await upsertAnalysisRuns(buf);
    buf = [];
  };

  for (let i = startAt; i < lines.length; i++) {
    try {
      const r = JSON.parse(lines[i]);
      if (r.error || r.response?.status_code !== 200) {
        failed++;
        continue;
      }
      const customId: string = r.custom_id ?? "";
      const callId = customId.startsWith("call-") ? customId.slice(5) : null;
      const content: string | null = r.response?.body?.choices?.[0]?.message?.content ?? null;
      if (!callId || !content) {
        failed++;
        continue;
      }
      buf.push({
        callId,
        campaignId: job.campaignId,
        promptId: job.promptId,
        promptTitle: job.promptTitle,
        promptContent: job.promptContent,
        summary: content,
        batchJobId: job.id,
        analyzedAt: now,
      });
      imported++;
    } catch {
      failed++;
    }
    if (buf.length >= BATCH) {
      await flush();
      await updateBatchJob(job.id, { imported_count: imported });
    }
  }
  await flush();
  await updateBatchJob(job.id, { imported_count: imported, completed_conversations: imported, failed_conversations: failed });

  return NextResponse.json({ imported: imported - startAt, failed, total: lines.length, resumedFrom: startAt });
}

// ── DELETE: cancel an active batch ────────────────────────────────────────────
export async function DELETE(request: NextRequest) {
  if (crossOrigin(request)) return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  let body: { batchJobId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const batchJobId = typeof body.batchJobId === "string" ? body.batchJobId : "";
  if (!batchJobId) return NextResponse.json({ error: "batchJobId is required" }, { status: 400 });

  const job = await getBatchJobById(batchJobId);
  if (!job) return NextResponse.json({ error: "Batch job not found" }, { status: 404 });
  if (!ACTIVE.has(job.status)) return NextResponse.json({ error: `Job cannot be cancelled (status: ${job.status})` }, { status: 400 });
  if (!job.openaiBatchId) return NextResponse.json({ error: "No OpenAI batch id on record" }, { status: 400 });

  const res = await fetch(`https://api.openai.com/v1/batches/${job.openaiBatchId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    return NextResponse.json({ error: `OpenAI cancel failed: ${d?.error?.message ?? res.status}` }, { status: 500 });
  }
  await updateBatchJob(batchJobId, { status: "cancelling" });
  return NextResponse.json({ ok: true });
}
