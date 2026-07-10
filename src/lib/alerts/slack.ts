import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Operator-alerting dispatcher + heartbeat helper.
 *
 * Phase 1 of docs/2026-05-28_DOC_Automation_Hardening_Roadmap.md (Priority 3
 * - Operator alerting). Pure leaf utility: no internal callers when first
 * shipped; callers (existing crons + new alerts-hourly) wire in incrementally.
 *
 * Security:
 *   - SLACK_ALERT_WEBHOOK_URL is bearer-style auth. Never logged; redacted
 *     from any err.message that might surface it.
 *   - cron_heartbeats is RLS-locked (no policies); supabaseAdmin bypasses.
 *
 * Failure-mode philosophy:
 *   - Never throws. All errors logged + return false (post) or void (heartbeat).
 *   - 3-second AbortSignal.timeout on the Slack POST so a slow Slack does NOT
 *     consume the cron handler's 60-second budget.
 *   - Heartbeat write failures are swallowed; the cron's actual work is
 *     never blocked by observability infrastructure.
 */

export type Severity = "INFO" | "WARN" | "ALERT";

/**
 * Stable cron-name identifiers used in cron_heartbeats.name and in the
 * alerts-hourly expected-cadence table. Centralized to prevent typos like
 * 'campagn-scheduler' becoming silent permanent failures.
 */
export const CRON_NAMES = {
  scheduler: "campaign-scheduler",
  heartbeat: "campaign-heartbeat",
  recordingBackfill: "recording-backfill",
  stuckSlotWatchdog: "stuck-slot-watchdog",
  alertsHourly: "alerts-hourly",
  scoreBackfill: "score-backfill",
  goldenReplay: "golden-replay",
  dailySnapshot: "daily-snapshot",
  realtimePoll: "realtime-poll",
} as const;

export type CronName = (typeof CRON_NAMES)[keyof typeof CRON_NAMES];

/**
 * Per-cron staleness budget in seconds. alerts-hourly considers a cron stale
 * (and alerts) when (now() - last_success_at) exceeds this. Sized as a
 * multiple of the cron's cadence to tolerate brief platform hiccups without
 * false alarms.
 */
export const CRON_STALENESS_THRESHOLD_SECONDS: Record<CronName, number> = {
  "campaign-scheduler": 300, // every 1min x 5 margin
  "recording-backfill": 1200, // every 5min x 4 margin
  "campaign-heartbeat": 5400, // every 30min x 3 margin
  "stuck-slot-watchdog": 93600, // daily (86400s) x ~1.08 -> 26h
  "alerts-hourly": 4500, // every 60min x 1.25 (self-monitor)
  "score-backfill": 5400, // every 30min x 3 margin (same as campaign-heartbeat)
  "golden-replay": 93600, // daily (86400s) x ~1.08 -> 26h, matches stuck-slot-watchdog
  "daily-snapshot": 93600, // daily (86400s) x ~1.08 -> 26h, matches the other daily crons
  "realtime-poll": 300, // every 1min x 5 margin, matches campaign-scheduler
};

const POST_TIMEOUT_MS = 3000;
const MAX_DETAIL_LINES = 10;

/**
 * Post one Slack alert. Returns true on 2xx, false on every other outcome.
 * Never throws.
 *
 * Caller decides WHEN to post; this function does not dedup. Sustained
 * anomalies will produce one message per call. Future dedup is tracked as a
 * follow-up in the Priority 3 roadmap section.
 */
export async function postSlackAlert(
  severity: Severity,
  title: string,
  details: string[],
): Promise<boolean> {
  const text = [
    `VOIZO ALERT [${severity}] - ${title}`,
    ...truncateDetails(details).map((d) => `- ${d}`),
    "",
    "Runbook: docs/2026-05-28_DOC_Automation_Hardening_Roadmap.md#priority-3",
  ].join("\n");
  return postToSlack(text, `severity=${severity} title="${title}"`);
}

/**
 * Informational run-narration (NOT an alert): no "ALERT" wording, no runbook
 * footer. Used by the recurring child-spawn branch to report normal activity
 * ("segment refreshed -> dialing X today, {window}"). Same transport, redaction,
 * and 3s timeout as postSlackAlert. Audit 2026-05-29 A.
 */
export async function postSlackNote(title: string, details: string[]): Promise<boolean> {
  const text = [`VOIZO • ${title}`, ...truncateDetails(details).map((d) => `- ${d}`)].join("\n");
  return postToSlack(text, `note title="${title}"`);
}

/** Truncate detail lines to the Slack size cap (shared by alert + note). */
function truncateDetails(details: string[]): string[] {
  return details.length > MAX_DETAIL_LINES
    ? [
        ...details.slice(0, MAX_DETAIL_LINES),
        `+${details.length - MAX_DETAIL_LINES} more (truncated for Slack size cap)`,
      ]
    : details;
}

/**
 * Shared Slack POST transport. Gated on SLACK_ALERT_WEBHOOK_URL (logs loudly if
 * absent), 3s timeout so a slow Slack can't eat the cron budget, never throws,
 * never logs the webhook URL. Returns true only on 2xx. `logContext` appears in
 * error logs only (never the message body / URL).
 */
async function postToSlack(text: string, logContext: string): Promise<boolean> {
  const webhookUrl = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    // [[loud-over-silent-skips]]: surface a missing env var loudly rather than
    // letting it become an invisible permanent silence. Never log the URL.
    console.warn(`[alerts] SLACK_ALERT_WEBHOOK_URL not present - skipping post: ${logContext}`);
    return false;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      const sanitized = body.replaceAll(webhookUrl, "[REDACTED_WEBHOOK_URL]");
      console.error(
        `[alerts] post failed: HTTP ${res.status} ${logContext} body=${sanitized.slice(0, 200)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const sanitized = reason.replaceAll(webhookUrl, "[REDACTED_WEBHOOK_URL]");
    console.error(`[alerts] post threw: ${logContext} reason=${sanitized}`);
    return false;
  }
}

/**
 * Best-effort UPSERT into cron_heartbeats. Each cron route handler calls
 * this immediately before its final NextResponse.json so a fresh row implies
 * the cron ran to completion.
 *
 * Failures are logged (warn) and swallowed - heartbeat is observability, not
 * load-bearing. A cron's actual work is never blocked by a heartbeat failure.
 *
 * Uses Node-side new Date().toISOString() for the timestamp. Clock skew vs
 * Postgres is bounded by NTP (<1s on Vercel + Supabase) and far smaller than
 * any staleness threshold (smallest is 300s).
 */
export async function recordHeartbeat(
  supabase: SupabaseClient,
  name: CronName,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("cron_heartbeats")
      .upsert(
        { name, last_success_at: new Date().toISOString() },
        { onConflict: "name" },
      );
    if (error) {
      console.warn(`[alerts] heartbeat write failed for ${name}: ${error.message}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[alerts] heartbeat write threw for ${name}: ${reason}`);
  }
}

/**
 * Dedup predicate for recurring spawn_failed alerts. A misconfigured parent
 * fails on every cron tick (~60s), so only alert when there is no prior alert
 * or the last one is older than windowMs (default 6h). State is keyed per parent
 * in recurring_alert_state. Audit 2026-05-29 A2.
 */
export function shouldAlertSpawnFail(
  lastAlertedAtIso: string | null,
  nowMs: number,
  windowMs: number = 6 * 60 * 60 * 1000,
): boolean {
  if (!lastAlertedAtIso) return true;
  return nowMs - Date.parse(lastAlertedAtIso) > windowMs;
}
