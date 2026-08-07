// scripts/qa-run-all-campaigns.mjs
//
// ALL-CAMPAIGNS QA bulk analysis (one OpenAI batch per campaign) for VAL PROMP (Official).
// Mirrors src/lib/qaBatchSubmit.ts submitCampaignBatch + the cross-campaign selector, but
// standalone so we can kick off the full back-catalog run now. Resume-safe: skips calls
// already analyzed with this prompt, and stops cleanly when OpenAI's enqueue cap is hit.
//
//   node scripts/qa-run-all-campaigns.mjs --dry     # count only, submit nothing
//   node scripts/qa-run-all-campaigns.mjs           # submit largest campaigns first
//   node scripts/qa-run-all-campaigns.mjs --days=7  # only calls from the last N days
//
// After submitting, import with:  node scripts/qa-import-batches.mjs   (re-run until done)

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
const MODEL = "gpt-5.4-mini";
const CONNECTED = ["completed", "answered"];

const DRY = process.argv.includes("--dry");
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Number(daysArg.split("=")[1]) : null;

const transcriptText = (t) => (!t ? "" : typeof t === "string" ? t : typeof t === "object" && typeof t.text === "string" ? t.text : "");
const isEnqueueLimit = (msg) => /enqueued|token_limit|queue|limit|quota|too many|429/i.test(msg);

async function resolvePrompt() {
  const { data } = await sb.from("listener_qa_prompts").select("id, title, content, is_active").order("is_active", { ascending: false });
  const byTitle = (data ?? []).find((p) => /val\s*promp/i.test(p.title));
  const chosen = byTitle ?? (data ?? []).find((p) => p.is_active) ?? (data ?? [])[0];
  if (!chosen) throw new Error("No prompt in listener_qa_prompts");
  return chosen;
}

async function pageAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const prompt = await resolvePrompt();
  console.log(`Prompt: "${prompt.title}" (${prompt.id})`);

  const sinceIso = DAYS ? new Date(Date.now() - DAYS * 86_400_000).toISOString() : null;
  if (sinceIso) console.log(`Window: calls since ${sinceIso}`);
  else console.log("Window: all time");

  // reached calls with a transcript
  const rows = await pageAll(() => {
    let q = sb.from("calls_v2").select("id, campaign_id, transcript").in("status", CONNECTED).not("transcript", "is", null).order("created_at", { ascending: false });
    if (sinceIso) q = q.gte("created_at", sinceIso);
    return q;
  });

  // ghost campaigns to exclude
  const { data: camps } = await sb.from("campaigns_v2").select("id, name, source");
  const ghost = new Set((camps ?? []).filter((c) => c.source === "ghost_portal").map((c) => c.id));
  const nameOf = new Map((camps ?? []).map((c) => [c.id, c.name]));

  // already analyzed with this prompt
  const analyzed = new Set();
  const done = await pageAll(() => sb.from("listener_qa_analysis_runs").select("call_id").eq("prompt_id", prompt.id));
  for (const r of done) analyzed.add(r.call_id);

  const byCampaign = new Map();
  let skippedEmpty = 0;
  for (const r of rows) {
    if (ghost.has(r.campaign_id) || analyzed.has(r.id)) continue;
    const t = transcriptText(r.transcript);
    if (!t.trim()) { skippedEmpty++; continue; }
    if (!byCampaign.has(r.campaign_id)) byCampaign.set(r.campaign_id, []);
    byCampaign.get(r.campaign_id).push({ id: r.id, transcript: t });
  }

  const order = [...byCampaign.entries()].sort((a, b) => b[1].length - a[1].length);
  const totalCalls = order.reduce((s, [, c]) => s + c.length, 0);
  console.log(`\nCandidates: ${totalCalls.toLocaleString()} un-analyzed reached calls across ${order.length} campaigns (already analyzed: ${analyzed.size.toLocaleString()}, empty transcripts skipped: ${skippedEmpty.toLocaleString()}).`);
  for (const [cid, calls] of order.slice(0, 30)) console.log(`  ${String(calls.length).padStart(5)}  ${nameOf.get(cid) ?? cid}`);
  if (order.length > 30) console.log(`  … +${order.length - 30} more campaigns`);

  if (DRY) { console.log("\n--dry: nothing submitted."); return; }
  if (totalCalls === 0) { console.log("\nNothing to submit — all caught up."); return; }

  let batches = 0, submitted = 0, stopped = false;
  for (const [cid, calls] of order) {
    if (stopped) break;
    try {
      const jsonl = calls.map((c) => JSON.stringify({
        custom_id: `call-${c.id}`, method: "POST", url: "/v1/chat/completions",
        body: { model: MODEL, messages: [{ role: "system", content: prompt.content }, { role: "user", content: `Score this call transcript:\n\n${c.transcript}` }], max_completion_tokens: 4096, temperature: 0, seed: 7 },
      })).join("\n");

      const form = new FormData();
      form.append("purpose", "batch");
      form.append("file", new Blob([jsonl], { type: "application/jsonl" }), `qa_all_${cid.slice(0, 8)}_${calls.length}.jsonl`);
      const upl = await fetch("https://api.openai.com/v1/files", { method: "POST", headers: { Authorization: "Bearer " + KEY }, body: form });
      const uplData = await upl.json();
      if (!upl.ok) throw new Error(uplData.error?.message ?? `file upload ${upl.status}`);

      const bres = await fetch("https://api.openai.com/v1/batches", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY }, body: JSON.stringify({ input_file_id: uplData.id, endpoint: "/v1/chat/completions", completion_window: "24h" }) });
      const bdata = await bres.json();
      if (!bres.ok) throw new Error(bdata.error?.message ?? `batch create ${bres.status}`);

      await sb.from("listener_qa_batch_jobs").insert({
        campaign_id: cid, openai_batch_id: bdata.id, openai_file_id: uplData.id, status: "validating",
        prompt_id: prompt.id, prompt_title: prompt.title, prompt_content: prompt.content,
        chunk_index: 0, total_chunks: 1, total_conversations: calls.length, submitted_at: new Date().toISOString(),
      });
      batches++; submitted += calls.length;
      console.log(`  ✓ ${String(calls.length).padStart(5)}  ${nameOf.get(cid) ?? cid}  (${bdata.id})`);
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (isEnqueueLimit(msg)) { stopped = true; console.log(`\n⏸  OpenAI queue full — stopping. ${batches} submitted so far. Re-run later to continue. (${msg.slice(0, 120)})`); }
      else console.log(`  ! skipped ${nameOf.get(cid) ?? cid}: ${msg.slice(0, 120)}`);
    }
  }
  console.log(`\nSubmitted ${batches} batch(es) / ${submitted.toLocaleString()} calls.${stopped ? " (partial — re-run to continue)" : ""}`);
  console.log("Import with:  node scripts/qa-import-batches.mjs   (re-run until 'still processing' is 0)");
}
main().catch((e) => { console.error(e); process.exit(1); });
