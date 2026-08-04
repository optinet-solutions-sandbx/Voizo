// src/lib/alerts/anomalySweep.ts
//
// VOZ-279: platform-wide anomaly sweep, called once per scheduler tick,
// EARLY (right after auth) so the queue-gate / pool-error early returns can
// never skip detection — those deferral paths are most common exactly when
// volume is high and anomalies matter most.
//
// Never throws, never blocks dialing: every failure is logged and swallowed
// (same philosophy as the Slack dispatcher). One calls_v2 read per tick;
// Slack posts are deduped to at most one per detector per hour via the
// alert_state table (2026-08-04_alert_state.sql) + the existing, tested
// shouldAlertSpawnFail window predicate.

import type { SupabaseClient } from "@supabase/supabase-js";
import { postSlackAlert, shouldAlertSpawnFail } from "./slack";
import {
  ANOMALY_ALERT_DEDUPE_MS,
  ANOMALY_WINDOW_MINUTES,
  detectAiPipelineBurst,
  detectConnectCollapse,
} from "./anomalyDetectors";

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export async function runAnomalySweep(supabase: SupabaseClient): Promise<void> {
  try {
    const since = new Date(Date.now() - ANOMALY_WINDOW_MINUTES * 60 * 1000).toISOString();
    // Newest-1000 sample by design: share-based thresholds stay correct under
    // the PostgREST clamp even at storm volume (08-03 peaked >6k calls/30min).
    const { data: rows, error } = await supabase
      .from("calls_v2")
      .select("ended_reason, hangup_cause, duration_seconds")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) {
      console.error("[anomaly-sweep] calls_v2 query failed:", error.message);
      return;
    }

    const calls = rows ?? [];
    const ai = detectAiPipelineBurst(calls.map((r) => (r.ended_reason as string | null) ?? null));
    if (ai.trip) {
      await fireDeduped(supabase, "ai_pipeline_burst", "AI provider failure — live calls have a silent agent", [
        `${ai.errCount} of ${ai.vapiCount} Vapi-reaching calls in the last ${ANOMALY_WINDOW_MINUTES} min ended with pipeline errors (${pct(ai.share)}).`,
        "Likely OpenAI quota/credential death or provider outage (08-02 signature: healthy base rate is 0%).",
        "Connected customers hear silence — every call burns money and caller-ID reputation.",
        "Check Vapi Logs → Ended Reason; verify quota with the POST api.vapi.ai/chat probe (never a test dial).",
      ]);
    }

    const cc = detectConnectCollapse(
      calls.map((r) => ({
        hangup_cause: (r.hangup_cause as string | null) ?? null,
        duration_seconds: (r.duration_seconds as number | null) ?? null,
      })),
    );
    if (cc.trip) {
      await fireDeduped(supabase, "connect_collapse", "Connect rate collapsed platform-wide", [
        `${cc.connected} of ${cc.dials} dials connected in the last ${ANOMALY_WINDOW_MINUTES} min (${pct(cc.rate)}; healthy baseline ~82%).`,
        "Trunk- or caller-ID-level problem spanning campaigns (08-02/03 signature).",
        "Check SquareTalk trunk + caller-ID health. The per-campaign reject breaker may also be auto-pausing campaigns.",
      ]);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[anomaly-sweep] threw (dialing unaffected): ${reason}`);
  }
}

/** Post at most once per ANOMALY_ALERT_DEDUPE_MS per key; alert_state keeps the clock. */
async function fireDeduped(
  supabase: SupabaseClient,
  key: string,
  title: string,
  details: string[],
): Promise<void> {
  const { data: state, error: stateErr } = await supabase
    .from("alert_state")
    .select("last_alerted_at")
    .eq("key", key)
    .maybeSingle();
  if (stateErr) {
    // Loud + fail-open: a broken dedupe table must not silence a real alert.
    console.error(`[anomaly-sweep] alert_state read failed for ${key} (alerting anyway):`, stateErr.message);
  }
  if (!stateErr && state && !shouldAlertSpawnFail(state.last_alerted_at as string, Date.now(), ANOMALY_ALERT_DEDUPE_MS)) {
    return; // alerted recently; condition persists — stay quiet until the window lapses
  }
  console.error(`[anomaly-sweep] TRIPPED ${key}: ${title}`);
  await postSlackAlert("ALERT", title, details);
  const { error: upsertErr } = await supabase
    .from("alert_state")
    .upsert({ key, last_alerted_at: new Date().toISOString() }, { onConflict: "key" });
  if (upsertErr) {
    console.error(`[anomaly-sweep] alert_state upsert failed for ${key}:`, upsertErr.message);
  }
}
