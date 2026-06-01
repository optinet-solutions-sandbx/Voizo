import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { CRON_NAMES, recordHeartbeat } from "@/lib/alerts/slack";
import crypto from "crypto";

// One backfill tick: SELECT up to 100 candidate rows, fetch each from Vapi
// API with concurrency=10, UPDATE the matched URLs. Vapi GET /call/{id} is
// ~200ms typical; 100 rows / 10 concurrency = ~2s wall time. 30s budget is
// generous and matches the heartbeat cron's allotment.
export const maxDuration = 30;

// Per-tick row cap. Bounds Vercel function time + Vapi API request volume
// per tick. With every-5-min schedule that's up to 28.8k/day if saturated —
// well under any practical throttle. Realistic load is dozens, not thousands.
const ROW_CAP = 100;

// Concurrency for Vapi API fetches. Each fetch is ~200ms, mostly waiting on
// Vapi. 10 parallel keeps wall time under 2s per tick without thrashing Vapi.
const FETCH_CONCURRENCY = 10;

// Per-fetch timeout. Vapi's GET /call/{id} is usually <500ms; 5s leaves
// generous margin for cold-path latency. Aborted fetches don't crash —
// the row stays NULL and is retried on the next tick.
const FETCH_TIMEOUT_MS = 5000;

// Lower bound: skip rows newer than this. Gives Vapi's async upload time
// to land before we attempt a fetch. 60s is well above the empirically
// observed ~5-10s upload latency.
const MIN_AGE_MS = 60 * 1000;

// Upper bound: stop trying after this. Sized to absorb prolonged cron-platform
// outages: pre-2026-06-01 this was 24h and a >24h Vercel cron outage or env-var
// availability gap would permanently abandon calls whose URLs Vapi eventually
// uploaded. 7d extends the recovery window without unbounded growth; candidate
// rows still narrow via `recording_url IS NULL AND vapi_call_id IS NOT NULL`
// so cost is bounded by the genuine-failure rate, not the wall-clock window.
// Audit 2026-06-01 H2.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GET /api/cron/recording-backfill
 *
 * Vercel Cron job — runs every 5 minutes (see vercel.json).
 *
 * Sweeps calls_v2 rows where recording_url IS NULL but vapi_call_id IS NOT
 * NULL and the row is between 1min and 24h old. For each row, GETs the call
 * object from Vapi's API and persists artifact.recording.mono.combinedUrl
 * (with the legacy artifact.recordingUrl fallback used in the webhook).
 *
 * Why this exists: the end-of-call webhook fires at call-end, but Vapi
 * uploads the recording asynchronously ~5-10s later. The webhook attempts
 * an API re-fetch, but that's gated on VAPI_PRIVATE_KEY availability at
 * webhook runtime which has proven unreliable. This cron is the durable
 * persistence layer — eventually consistent, every 5 min.
 *
 * Security: Vercel injects `Authorization: Bearer ${CRON_SECRET}` on
 * cron-triggered requests. Same pattern as campaign-scheduler / heartbeat.
 *
 * Cost (CLAUDE.md non-negotiable #4):
 *   - Cron: 288 invocations/day, well within Vercel limits
 *   - Vapi GET /call/{id}: no per-request charge
 *   - Supabase: 1 SELECT + up to 100 UPDATEs per tick — negligible
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[recording-backfill] CRON_SECRET not set — rejecting");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const expected = `Bearer ${cronSecret}`;
  const received = authHeader || "";
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Verify Vapi API key (required for any fetch) ──
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    console.error("[recording-backfill] VAPI_PRIVATE_KEY not set — rejecting");
    return NextResponse.json({ error: "Vapi key not configured" }, { status: 500 });
  }

  // ── Query candidate rows ──
  const now = Date.now();
  const minTs = new Date(now - MAX_AGE_MS).toISOString(); // oldest we'll touch
  const maxTs = new Date(now - MIN_AGE_MS).toISOString(); // newest we'll touch

  const { data: rows, error: queryErr } = await supabaseAdmin
    .from("calls_v2")
    .select("id, vapi_call_id")
    .is("recording_url", null)
    .not("vapi_call_id", "is", null)
    .gte("created_at", minTs)
    .lte("created_at", maxTs)
    .order("created_at", { ascending: false })
    .limit(ROW_CAP);

  if (queryErr) {
    console.error("[recording-backfill] candidate query failed:", queryErr);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    console.log("[recording-backfill] no candidate rows");
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.recordingBackfill);
    return NextResponse.json({ scanned: 0, fetched: 0, updated: 0, errors: 0, no_url_yet: 0 });
  }

  // ── Per-row fetch + update with bounded concurrency ──
  // Chunk into CONCURRENCY-sized batches; await each batch before the next.
  // Simpler than a worker-pool loop and adequate for ROW_CAP=100.
  type RowResult =
    | { id: string; status: "updated"; url: string }
    | { id: string; status: "no_url_yet" }
    | { id: string; status: "error"; reason: string };

  const results: RowResult[] = [];

  for (let i = 0; i < rows.length; i += FETCH_CONCURRENCY) {
    const chunk = rows.slice(i, i + FETCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map((row): Promise<RowResult> =>
        processRow(row.id as string, row.vapi_call_id as string, vapiKey),
      ),
    );
    results.push(...chunkResults);
  }

  const counts = {
    scanned: rows.length,
    fetched: results.filter((r) => r.status === "updated").length,
    updated: results.filter((r) => r.status === "updated").length,
    errors: results.filter((r) => r.status === "error").length,
    no_url_yet: results.filter((r) => r.status === "no_url_yet").length,
  };

  console.log(
    `[recording-backfill] scanned=${counts.scanned} updated=${counts.updated} ` +
    `errors=${counts.errors} no_url_yet=${counts.no_url_yet}`,
  );

  await recordHeartbeat(supabaseAdmin, CRON_NAMES.recordingBackfill);
  return NextResponse.json(counts);
}

/**
 * Process one calls_v2 row: GET from Vapi, extract URL, UPDATE if found.
 *
 * Returns a discriminated result for the cron's aggregate counters.
 * Errors are caught and returned, NEVER thrown — one bad row mustn't
 * break the rest of the batch.
 */
async function processRow(
  id: string,
  vapiCallId: string,
  vapiKey: string,
): Promise<
  | { id: string; status: "updated"; url: string }
  | { id: string; status: "no_url_yet" }
  | { id: string; status: "error"; reason: string }
> {
  let res: Response;
  try {
    res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(vapiCallId)}`, {
      headers: { Authorization: `Bearer ${vapiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[recording-backfill] fetch threw for ${id} (vapi=${vapiCallId}): ${reason}`);
    return { id, status: "error", reason };
  }

  if (!res.ok) {
    console.warn(`[recording-backfill] fetch ${res.status} for ${id} (vapi=${vapiCallId})`);
    return { id, status: "error", reason: `http_${res.status}` };
  }

  let callObj: Record<string, unknown>;
  try {
    callObj = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { id, status: "error", reason: `json_parse: ${reason}` };
  }

  const artifact = callObj.artifact as Record<string, unknown> | undefined;
  const mono = (artifact?.recording as Record<string, unknown> | undefined)?.mono as Record<string, unknown> | undefined;
  const url: string | null =
    (typeof mono?.combinedUrl === "string" ? mono.combinedUrl : null) ??
    (typeof artifact?.recordingUrl === "string" ? (artifact.recordingUrl as string) : null);

  if (!url) {
    return { id, status: "no_url_yet" };
  }

  // Race-safe UPDATE: only write if still NULL. If the webhook (or a
  // concurrent cron tick) already populated it, leave the existing value.
  const { error: updateErr } = await supabaseAdmin
    .from("calls_v2")
    .update({ recording_url: url })
    .eq("id", id)
    .is("recording_url", null);

  if (updateErr) {
    console.warn(`[recording-backfill] update failed for ${id}: ${updateErr.message}`);
    return { id, status: "error", reason: `update: ${updateErr.message}` };
  }

  return { id, status: "updated", url };
}
