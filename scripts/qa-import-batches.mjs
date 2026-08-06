// scripts/qa-import-batches.mjs
//
// Import sweep for QA bulk-analysis batches. Polls OpenAI for each active
// listener_qa_batch_jobs row, and for any COMPLETED batch downloads its output
// and upserts the results into listener_qa_analysis_runs (idempotent on
// call_id,batch_job_id — resume-safe via imported_count). Mirrors the tool's
// /api/qa-prompt-testing/batch PATCH, but sweeps every job in one run so a bulk
// submission doesn't need 22 manual "Import" clicks.
//
// Run:  node scripts/qa-import-batches.mjs      (re-run until everything is imported)

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {};
for (const l of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const KEY = env.OPENAI_API_KEY;
const ACTIVE = new Set(["validating", "in_progress", "finalizing"]);
const MAP = { validating: "validating", in_progress: "in_progress", finalizing: "finalizing", completed: "completed", expired: "expired", cancelling: "cancelling", cancelled: "cancelled", failed: "failed" };

async function main() {
  const { data: jobs, error } = await sb
    .from("listener_qa_batch_jobs")
    .select("id, campaign_id, openai_batch_id, output_file_id, status, prompt_id, prompt_title, prompt_content, total_conversations, imported_count")
    .order("created_at", { ascending: false });
  if (error) { console.error("read jobs failed:", error.message); process.exit(1); }

  let polled = 0, importedTotal = 0, doneCount = 0, activeCount = 0;
  for (const j of jobs) {
    // 1) refresh status for active jobs
    if (j.openai_batch_id && ACTIVE.has(j.status)) {
      polled++;
      try {
        const r = await fetch(`https://api.openai.com/v1/batches/${j.openai_batch_id}`, { headers: { Authorization: "Bearer " + KEY } });
        if (r.ok) {
          const b = await r.json();
          const status = MAP[b.status] ?? "in_progress";
          const c = b.request_counts ?? {};
          const patch = { status, completed_conversations: c.completed ?? 0, failed_conversations: c.failed ?? 0 };
          if (status === "completed") { patch.output_file_id = b.output_file_id ?? null; patch.completed_at = new Date().toISOString(); }
          if (status === "failed" || status === "expired") patch.error_message = b.errors?.data?.[0]?.message ?? status;
          await sb.from("listener_qa_batch_jobs").update(patch).eq("id", j.id);
          j.status = status; j.output_file_id = patch.output_file_id ?? j.output_file_id;
        }
      } catch { /* transient */ }
    }
    if (ACTIVE.has(j.status)) activeCount++;

    // 2) import completed-but-not-fully-imported
    if (j.status === "completed" && j.output_file_id && (j.imported_count ?? 0) < j.total_conversations) {
      try {
        const r = await fetch(`https://api.openai.com/v1/files/${j.output_file_id}/content`, { headers: { Authorization: "Bearer " + KEY } });
        if (!r.ok) { console.log(`  ! download failed ${j.id.slice(0, 8)} ${r.status}`); continue; }
        const lines = (await r.text()).split("\n").filter((l) => l.trim());
        const startAt = j.imported_count ?? 0;
        const now = new Date().toISOString();
        let buf = [], imported = startAt, failed = 0;
        const flush = async () => { if (buf.length) { await sb.from("listener_qa_analysis_runs").upsert(buf, { onConflict: "call_id,batch_job_id" }); buf = []; } };
        for (let i = startAt; i < lines.length; i++) {
          try {
            const res = JSON.parse(lines[i]);
            if (res.error || res.response?.status_code !== 200) { failed++; continue; }
            const cid = (res.custom_id || "").startsWith("call-") ? res.custom_id.slice(5) : null;
            const content = res.response?.body?.choices?.[0]?.message?.content ?? null;
            if (!cid || !content) { failed++; continue; }
            buf.push({ call_id: cid, campaign_id: j.campaign_id, prompt_id: j.prompt_id, prompt_title: j.prompt_title, prompt_content: j.prompt_content, summary: content, batch_job_id: j.id, analyzed_at: now });
            imported++;
          } catch { failed++; }
          if (buf.length >= 100) { await flush(); await sb.from("listener_qa_batch_jobs").update({ imported_count: imported }).eq("id", j.id); }
        }
        await flush();
        await sb.from("listener_qa_batch_jobs").update({ imported_count: imported, completed_conversations: imported, failed_conversations: failed }).eq("id", j.id);
        const net = imported - startAt;
        importedTotal += net;
        doneCount++;
        console.log(`  imported ${net} (+${startAt} prior) failed=${failed}  ${j.id.slice(0, 8)}`);
      } catch (err) { console.log(`  ! import threw ${j.id.slice(0, 8)} ${err.message}`); }
    }
  }
  console.log(`\nsweep: ${jobs.length} jobs | ${activeCount} still processing | imported ${importedTotal} results across ${doneCount} completed batch(es).`);
  if (activeCount > 0) console.log("Re-run this script until 'still processing' hits 0.");
}
main().catch((e) => { console.error(e); process.exit(1); });
