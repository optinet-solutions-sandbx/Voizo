// src/lib/qaBatchSubmit.ts
//
// Shared OpenAI-Batch submit + import for QA bulk analysis, used by the manual
// all-campaigns runner and the daily cron (the per-campaign page has its own inline
// copy). submitCampaignBatch: JSONL -> Files upload -> create batch -> job row.
// importCompletedBatches: poll active jobs, then import every completed-but-unimported
// one into listener_qa_analysis_runs (idempotent on call_id,batch_job_id).
import {
  insertBatchJob,
  getAllBatchJobs,
  updateBatchJob,
  upsertAnalysisRuns,
  pollActiveJobs,
  type ReachedCall,
  type AnalysisRunInsert,
} from "./qaBatchData";

const MODEL = "gpt-5.4-mini";

function jsonlLine(callId: string, transcript: string, promptContent: string): string {
  return JSON.stringify({
    custom_id: `call-${callId}`,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: MODEL,
      messages: [
        { role: "system", content: promptContent },
        { role: "user", content: `Score this call transcript:\n\n${transcript}` },
      ],
      max_completion_tokens: 4096,
      // Deterministic classification so re-runs don't flip borderline calls
      // (Neutral <-> Early Hang-up). See qa-prompt-testing/run/route.ts.
      temperature: 0,
      seed: 7,
    },
  });
}

async function uploadJsonl(lines: string[], fileName: string, apiKey: string): Promise<string> {
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([lines.join("\n")], { type: "application/jsonl" }), fileName);
  const res = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form });
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

/** Submit ONE campaign's reached calls as an OpenAI batch + persist the job row. Throws on OpenAI error. */
export async function submitCampaignBatch(input: {
  campaignId: string;
  calls: ReachedCall[];
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  apiKey: string;
}): Promise<{ jobId: string; batchId: string; count: number }> {
  const lines = input.calls.map((c) => jsonlLine(c.id, c.transcript, input.promptContent));
  const fileId = await uploadJsonl(lines, `qa_batch_${input.campaignId.slice(0, 8)}_${lines.length}.jsonl`, input.apiKey);
  const batchId = await createBatch(fileId, input.apiKey);
  const job = await insertBatchJob({
    campaignId: input.campaignId,
    openaiBatchId: batchId,
    openaiFileId: fileId,
    status: "validating",
    promptId: input.promptId,
    promptTitle: input.promptTitle,
    promptContent: input.promptContent,
    chunkIndex: 0,
    totalChunks: 1,
    totalConversations: input.calls.length,
    submittedAt: new Date().toISOString(),
  });
  return { jobId: job.id, batchId, count: input.calls.length };
}

/** Detect an OpenAI "batch queue full" style error so the caller can stop submitting more. */
export function isEnqueueLimit(message: string): boolean {
  return /enqueued|token_limit|queue|limit|quota|too many|429/i.test(message);
}

/** Poll all active batches, then import every completed-but-unimported one. Idempotent + resume-safe. */
export async function importCompletedBatches(apiKey: string): Promise<{ imported: number; completed: number; active: number }> {
  const jobs = await getAllBatchJobs();
  await pollActiveJobs(jobs, apiKey);

  const ACTIVE = new Set(["validating", "in_progress", "finalizing"]);
  let imported = 0;
  let completed = 0;
  let active = 0;

  for (const j of jobs) {
    if (ACTIVE.has(j.status)) active++;
    if (j.status !== "completed" || !j.outputFileId || j.importedCount >= j.totalConversations) continue;
    try {
      const res = await fetch(`https://api.openai.com/v1/files/${j.outputFileId}/content`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) continue;
      const lines = (await res.text()).split("\n").filter((l) => l.trim());
      const startAt = j.importedCount ?? 0;
      const now = new Date().toISOString();
      let done = startAt;
      let failed = 0;
      let buf: AnalysisRunInsert[] = [];
      const flush = async () => {
        if (buf.length) {
          await upsertAnalysisRuns(buf);
          buf = [];
        }
      };
      for (let i = startAt; i < lines.length; i++) {
        try {
          const r = JSON.parse(lines[i]);
          if (r.error || r.response?.status_code !== 200) { failed++; continue; }
          const callId = (r.custom_id || "").startsWith("call-") ? r.custom_id.slice(5) : null;
          const content = r.response?.body?.choices?.[0]?.message?.content ?? null;
          if (!callId || !content) { failed++; continue; }
          buf.push({ callId, campaignId: j.campaignId, promptId: j.promptId, promptTitle: j.promptTitle, promptContent: j.promptContent, summary: content, batchJobId: j.id, analyzedAt: now });
          done++;
        } catch { failed++; }
        if (buf.length >= 100) { await flush(); await updateBatchJob(j.id, { imported_count: done }); }
      }
      await flush();
      await updateBatchJob(j.id, { imported_count: done, completed_conversations: done, failed_conversations: failed });
      imported += done - startAt;
      completed++;
    } catch {
      /* transient — next sweep retries */
    }
  }
  return { imported, completed, active };
}
