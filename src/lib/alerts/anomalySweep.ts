// src/lib/alerts/anomalySweep.ts
//
// VOZ-279: platform-wide anomaly sweep, called once per scheduler tick,
// EARLY (right after auth) so the queue-gate / pool-error early returns can
// never skip detection — those deferral paths are most common exactly when
// volume is high and anomalies matter most.
//
// Never throws, never blocks dialing: every failure is logged and swallowed
// (same philosophy as the Slack dispatcher). One calls_v2 read per tick for
// detectors A/B, plus one campaigns_v2 read and a few head-only counts for the
// dial-silence detector (VOZ-437 — only campaigns that should be dialling right
// now are consulted). Slack posts are deduped to at most one per detector per
// hour via the alert_state table (2026-08-04_alert_state.sql) + the existing,
// tested shouldAlertSpawnFail window predicate.

import type { SupabaseClient } from "@supabase/supabase-js";
import { postSlackAlert, shouldAlertSpawnFail } from "./slack";
import {
  ANOMALY_ALERT_DEDUPE_MS,
  ANOMALY_WINDOW_MINUTES,
  DIAL_SILENCE_MINUTES,
  detectAiPipelineBurst,
  detectConnectCollapse,
  detectDialSilence,
  detectRobotTexted,
  type DialSilenceCandidate,
  type RobotTextedCandidate,
} from "./anomalyDetectors";
import { isWithinCallWindowAt, type CallWindowLite } from "../scheduleWindow";
import { countDialingCampaigns } from "../scheduler/dialingCampaigns";

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

    // ── Detector C — dial silence (VOZ-437) ──
    // Detectors A/B need dials to exist. This one catches their ABSENCE: a child
    // inside its call window for >= DIAL_SILENCE_MINUTES, with players due, and not
    // one calls_v2 row minted. Only in-window children are consulted, and the due-
    // numbers count runs only for the ones that are actually quiet — a handful of
    // head-only counts per tick. Excludes 'paused' (deliberate silence) and recurring
    // parents (never dial; scope exclusion, not a window pre-guard — see VOZ-364).
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const silenceStartMs = nowMs - DIAL_SILENCE_MINUTES * 60 * 1000;
    const silenceStartIso = new Date(silenceStartMs).toISOString();
    const { data: kids, error: kidsErr } = await supabase
      .from("campaigns_v2")
      .select("id, name, status, start_at, end_at, call_windows, timezone, max_attempts")
      .in("status", ["draft", "running"])
      .neq("campaign_type", "recurring")
      .lte("start_at", nowIso)
      .or(`end_at.is.null,end_at.gt.${nowIso}`);
    if (kidsErr) {
      console.error("[anomaly-sweep] campaigns_v2 query failed (dial-silence skipped):", kidsErr.message);
    } else {
      const candidates: DialSilenceCandidate[] = [];
      for (const k of kids ?? []) {
        const windows = (k.call_windows as CallWindowLite[] | null) ?? [];
        const tz = k.timezone as string;
        const startAtMs = new Date(k.start_at as string).getTime();
        // Cheap pure checks first so the counts below run only for real candidates.
        const inWindowThroughout =
          isWithinCallWindowAt(windows, tz, nowMs) && isWithinCallWindowAt(windows, tz, silenceStartMs);
        if (!inWindowThroughout || !(startAtMs <= silenceStartMs)) continue;

        const { count: recentCalls, error: rcErr } = await supabase
          .from("calls_v2")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", k.id as string)
          .gte("created_at", silenceStartIso);
        if (rcErr) {
          console.error(`[anomaly-sweep] calls_v2 count failed for ${k.id} (skipped):`, rcErr.message);
          continue;
        }
        if ((recentCalls ?? 0) > 0) continue; // dialling — nothing to check

        // findNextNumber's own eligibility (dialer.ts): under max_attempts, and either
        // fresh or a retry whose time has come. All-on-timers is a legitimately quiet book.
        const maxAttempts = (k.max_attempts as number | null) ?? 3;
        const { count: dueNumbers, error: dueErr } = await supabase
          .from("campaign_numbers_v2")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", k.id as string)
          .lt("attempt_count", maxAttempts)
          .or(`outcome.eq.pending,and(outcome.eq.pending_retry,next_attempt_at.lte.${nowIso})`);
        if (dueErr) {
          console.error(`[anomaly-sweep] campaign_numbers_v2 count failed for ${k.id} (skipped):`, dueErr.message);
          continue;
        }
        candidates.push({
          id: k.id as string,
          name: (k.name as string) ?? (k.id as string),
          status: k.status as string,
          inWindowThroughout,
          startAtMs,
          recentCalls: 0,
          dueNumbers: dueNumbers ?? 0,
        });
      }

      const ds = detectDialSilence(candidates, nowMs);
      if (ds.trip) {
        // Say WHICH kind of silence: queued behind a full gate, or a stall with the gate open.
        const { count: dialing } = await countDialingCampaigns(supabase);
        const limit = parseInt(process.env.CAMPAIGN_CONCURRENCY_LIMIT ?? "3", 10);
        const gateFull = (dialing ?? 0) >= limit;
        await fireDeduped(supabase, "dial_silence", "Dialling has stopped — campaigns in window with players due, zero calls", [
          ...ds.silent.map(
            (c) =>
              `${c.name} (${c.status}): ${c.dueNumbers} players due, 0 calls in the last ${DIAL_SILENCE_MINUTES} min ` +
              `(in window since ${new Date(c.startAtMs).toISOString().slice(11, 16)}Z).`,
          ),
          `${dialing ?? "?"} of ${limit} campaign lines in use — ` +
            (gateFull
              ? "the queue gate is FULL; these campaigns are queued behind it."
              : "the gate is OPEN, so this is a stall (promotion, dialer, or trunk), not capacity."),
          "Check the campaign-scheduler cron log for the last tick's `reason`, then vapi_sip_pool leases (08-25 deadlock signature: leased slots held by paused/expired children).",
        ]);
      }
    }

    // ── Detector D — texted a robot (2026-08-27) ──
    // Re-reads every text sent in the window against the call it was sent from. Every
    // robot ever texted traces to a machine script the classifier had not seen yet, and
    // each was found by hand, days late. Three reads, all small: the window's sms rows
    // (a few dozen at most), their calls, their campaigns. Any failure logs and skips —
    // this detector must never take the others down with it. Every sms row carries a
    // call_id (7,398 of 7,398 measured 2026-08-27), so the inner join loses nothing.
    const { data: smsRows, error: smsErr } = await supabase
      .from("sms_messages_v2")
      .select("id, call_id, campaign_id")
      .gte("created_at", since)
      .not("call_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(200);
    if (smsErr) {
      console.error("[anomaly-sweep] sms_messages_v2 query failed (robot-texted skipped):", smsErr.message);
    } else if ((smsRows ?? []).length > 0) {
      const sms = smsRows ?? [];
      const callIds = Array.from(new Set(sms.map((s) => s.call_id as string)));
      const campIds = Array.from(new Set(sms.map((s) => s.campaign_id as string).filter(Boolean)));
      // campaign_id is nullable on sms rows; an empty .in() list is a query we never want to send.
      const [{ data: callRows, error: callErr }, { data: campRows, error: campErr }] = await Promise.all([
        supabase.from("calls_v2").select("id, transcript").in("id", callIds),
        campIds.length > 0
          ? supabase.from("campaigns_v2").select("id, name, sms_consent_mode").in("id", campIds)
          : Promise.resolve({ data: [] as { id: string; name: string | null; sms_consent_mode: string | null }[], error: null }),
      ]);
      if (callErr || campErr) {
        console.error("[anomaly-sweep] robot-texted joins failed (skipped):", callErr?.message ?? campErr?.message);
      } else {
        // calls_v2.transcript is jsonb { text } in the DB (a plain string only in tests).
        const transcriptOf = new Map<string, string>();
        for (const c of callRows ?? []) {
          const t = c.transcript as { text?: string | null } | string | null;
          transcriptOf.set(c.id as string, typeof t === "string" ? t : (t?.text ?? ""));
        }
        const campOf = new Map<string, { name: string; mode: string | null }>();
        for (const k of campRows ?? []) {
          campOf.set(k.id as string, { name: (k.name as string) ?? (k.id as string), mode: (k.sms_consent_mode as string | null) ?? null });
        }
        const candidates: RobotTextedCandidate[] = sms.map((s) => {
          const camp = campOf.get(s.campaign_id as string);
          return {
            smsId: s.id as string,
            callId: s.call_id as string,
            campaignName: camp?.name ?? (s.campaign_id as string) ?? "(unknown campaign)",
            mode: camp?.mode ?? null,
            transcript: transcriptOf.get(s.call_id as string) ?? "",
          };
        });
        const rt = detectRobotTexted(candidates);
        if (rt.trip) {
          await fireDeduped(supabase, "robot_texted", "Texted an answering machine — a machine script the classifier does not know", [
            ...rt.offenders.map(
              (o) => `${o.campaignName}: [${o.rule}] "${o.excerpt}" (call ${o.callId.slice(0, 8)}).`,
            ),
            `${rt.offenders.length} of ${candidates.length} texts in the last ${ANOMALY_WINDOW_MINUTES} min went to something that reads as a machine. Each costs EUR 0.03-0.11 and counts a machine as a reached human.`,
            "Add the phrase to transcriptClassify.ts (LABEL tier, never the kill tier) after replaying it over prod transcripts — the VOZ-463 discipline: patterns from the transcripts, zero real humans flipping.",
          ]);
        }
      }
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
