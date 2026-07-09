import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { CRON_NAMES, recordHeartbeat } from "@/lib/alerts/slack";
import {
  buildCampaignIndex,
  computeWindowPerf,
  type DashCallRow,
  type DashCampaignRow,
  type DashSmsRow,
  type DashNumberRow,
} from "@/lib/dashboardAnalytics";
import { SNAPSHOT_RECIPIENTS, yesterdayWindowUtc, buildSnapshotEmail } from "@/lib/dailySnapshot";
import { sendEmail } from "@/lib/email";

/**
 * GET /api/cron/daily-snapshot
 *
 * Vercel Cron — daily 07:00 UTC (see vercel.json). Emails the 7 business
 * recipients a headline summary of the PREVIOUS full UTC day (Val's ticket
 * 1216096014477809). Read-only Supabase + one Resend POST + one heartbeat.
 *
 * ?dry=1 → build + return the email as JSON WITHOUT sending. So the route can
 * be verified locally without emailing the real recipient list.
 *
 * Failure-mode: sendEmail throws on a missing key / non-2xx → 500, heartbeat is
 * NOT recorded → alerts-hourly warns after the 26h staleness threshold. A
 * transient failure self-recovers on the next day's tick.
 *
 * Cost: zero Vapi/Mobivate/SquareTalk. Resend free tier (7 emails/day).
 */
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[daily-snapshot] CRON_SECRET not set — rejecting");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  const expected = `Bearer ${cronSecret}`;
  const received = request.headers.get("authorization") || "";
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const { startMs, endMs, dateLabel } = yesterdayWindowUtc(now);
  // Fetch a lower-bounded window (>= yesterday 00:00). computeWindowPerf applies
  // the [startMs, endMs] upper bound, so any of today's early calls are ignored.
  const cutoffIso = new Date(startMs).toISOString();

  const [callRowsRaw, campaignRowsRaw, smsRowsRaw] = await Promise.all([
    fetchAllRows(
      supabaseAdmin,
      "calls_v2",
      "id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds, transcript",
      "id",
      undefined,
      { column: "created_at", value: cutoffIso },
    ),
    fetchAllRows(
      supabaseAdmin,
      "campaigns_v2",
      "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, start_at, created_at, end_at",
      "id",
    ),
    fetchAllRows(
      supabaseAdmin,
      "sms_messages_v2",
      "campaign_id, created_at, status, call_id, campaign_number_id",
      "id",
      undefined,
      { column: "created_at", value: cutoffIso },
    ),
  ]);

  const allCalls = callRowsRaw as unknown as DashCallRow[];
  const campaigns = campaignRowsRaw as unknown as DashCampaignRow[];
  const allSms = smsRowsRaw as unknown as DashSmsRow[];

  // Exclude ghost + test campaigns (mirror the client-facing exclusion in today/route).
  const index = buildCampaignIndex(campaigns);
  const isLive = (campaignId: string) => {
    const c = index.get(campaignId);
    return !!c && c.source !== "ghost_portal" && c.is_test !== true;
  };
  const liveCalls = allCalls.filter((c) => isLive(c.campaign_id));
  const liveSms = allSms.filter((m) => isLive(m.campaign_id));

  // declined bucket: campaign_numbers_v2.outcome === 'declined_offer' for the windowed calls.
  const numIds = [
    ...new Set(liveCalls.map((c) => c.campaign_number_id).filter((x): x is string => !!x)),
  ];
  const IN_CHUNK = 150;
  const declinedIds = new Set<string>();
  for (let i = 0; i < numIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, outcome")
      .in("id", numIds.slice(i, i + IN_CHUNK));
    if (error) {
      console.error("[daily-snapshot] numbers query failed:", error);
      return NextResponse.json({ error: "Failed to read snapshot data" }, { status: 500 });
    }
    for (const n of (data ?? []) as unknown as DashNumberRow[]) {
      if ((n.outcome ?? "") === "declined_offer") declinedIds.add(n.id);
    }
  }

  const perf = computeWindowPerf(liveCalls, liveSms, declinedIds, startMs, endMs, {
    useTranscript: true,
  });

  // SMS sent/delivered in the window (raw count — the perf.sms block is outcome-derived, not send status).
  const smsSent = liveSms.filter((m) => {
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    return (
      Number.isFinite(t) &&
      t >= startMs &&
      t <= endMs &&
      (m.status === "sent" || m.status === "delivered")
    );
  }).length;

  const dashboardUrl = process.env.SNAPSHOT_DASHBOARD_URL ?? "https://voizo-eight.vercel.app";
  const { subject, html } = buildSnapshotEmail(perf, smsSent, dateLabel, dashboardUrl);

  if (request.nextUrl.searchParams.get("dry") === "1") {
    return NextResponse.json({ dryRun: true, dateLabel, recipients: SNAPSHOT_RECIPIENTS, subject, html });
  }

  const messageId = await sendEmail(SNAPSHOT_RECIPIENTS, subject, html);
  await recordHeartbeat(supabaseAdmin, CRON_NAMES.dailySnapshot);

  return NextResponse.json({
    sent: true,
    dateLabel,
    recipients: SNAPSHOT_RECIPIENTS.length,
    messageId,
  });
}
