import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET /api/dashboard/activity
 *
 * Live operations console feed. Returns:
 *   - recentCalls       (top ~50 most recent calls in last 24h, with phone + campaign name)
 *   - recentSms         (last ~50 SMS messages, with status + body preview)
 *   - outcomes24h       (status distribution across all 24h calls, plus goal-reached count)
 *   - perNumberRecent   (top ~30 most-recently-attempted numbers with their current outcome,
 *                        attempt count, and last status/duration)
 *
 * One 24h window pull from calls_v2 powers recentCalls + outcomes24h + the call seed
 * for perNumberRecent. A small follow-up query fills in the campaign_numbers_v2
 * outcome/attempt_count for the ids that appear in the call window.
 *
 * CSRF policy: lenient on missing Origin (read-only GET) per
 * feedback_csrf_origin_check_get_lenient.
 *
 * Polled by /activity (full page) and /dashboard (compact widget) at 30s intervals.
 */

const MS_PER_HOUR = 3_600_000;
const ACTIVITY_WINDOW_HOURS = 24;
const CALL_HARD_LIMIT = 500;      // Safety cap; aggregates use whatever is returned
const RECENT_CALL_LIMIT = 50;
const SMS_LIMIT = 50;
const PER_NUMBER_LIMIT = 30;

interface CallRow {
  id: string;
  created_at: string;
  status: string;
  duration_seconds: number | null;
  goal_reached: boolean | null;
  campaign_id: string;
  campaign_number_id: string;
  // Supabase FK embed — single phone per call, but the client returns either object or array.
  campaign_numbers_v2: { phone_e164: string } | { phone_e164: string }[] | null;
}

interface SmsRow {
  id: string;
  created_at: string;
  status: string;
  to_phone_e164: string;
  body: string;
  error_message: string | null;
  campaign_id: string;
}

interface CampaignBrief {
  id: string;
  name: string;
}

interface NumberBrief {
  id: string;
  campaign_id: string;
  phone_e164: string;
  outcome: string;
  attempt_count: number;
  last_attempted_at: string | null;
}

function phoneFor(call: CallRow): string {
  const p = call.campaign_numbers_v2;
  if (Array.isArray(p)) return p[0]?.phone_e164 ?? "";
  return p?.phone_e164 ?? "";
}

export async function GET(request: NextRequest) {
  // Origin check (lenient on GET).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const o = new URL(origin);
      if (o.host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const now = new Date();
  const cutoffIso = new Date(now.getTime() - ACTIVITY_WINDOW_HOURS * MS_PER_HOUR).toISOString();

  // Parallel pull: calls (24h), SMS (last 50), campaigns list.
  const [callsRes, smsRes, campsRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select(
        "id, created_at, status, duration_seconds, goal_reached, campaign_id, campaign_number_id, campaign_numbers_v2!campaign_number_id(phone_e164)",
      )
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(CALL_HARD_LIMIT),
    supabaseAdmin
      .from("sms_messages_v2")
      .select("id, created_at, status, to_phone_e164, body, error_message, campaign_id")
      .order("created_at", { ascending: false })
      .limit(SMS_LIMIT),
    supabaseAdmin.from("campaigns_v2").select("id, name"),
  ]);

  if (callsRes.error) {
    console.error("[dashboard/activity] calls_v2 query failed:", callsRes.error);
    return NextResponse.json({ error: "Failed to read calls" }, { status: 500 });
  }
  if (smsRes.error) {
    console.error("[dashboard/activity] sms_messages_v2 query failed:", smsRes.error);
    return NextResponse.json({ error: "Failed to read SMS" }, { status: 500 });
  }
  if (campsRes.error) {
    console.error("[dashboard/activity] campaigns_v2 query failed:", campsRes.error);
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const calls = (callsRes.data ?? []) as unknown as CallRow[];
  const sms = (smsRes.data ?? []) as unknown as SmsRow[];
  const camps = (campsRes.data ?? []) as unknown as CampaignBrief[];
  const campByID = new Map<string, string>(camps.map((c) => [c.id, c.name]));

  // ── Recent calls (top N) ─────────────────────────────────────────────
  const recentCalls = calls.slice(0, RECENT_CALL_LIMIT).map((c) => ({
    id: c.id,
    createdAt: c.created_at,
    status: c.status,
    durationSeconds: c.duration_seconds,
    goalReached: c.goal_reached,
    campaignId: c.campaign_id,
    campaignName: campByID.get(c.campaign_id) ?? "—",
    phoneE164: phoneFor(c),
  }));

  // ── Outcome distribution 24h ─────────────────────────────────────────
  const byStatus: Record<string, number> = {};
  let goalReachedCount = 0;
  for (const c of calls) {
    byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    if (c.goal_reached) goalReachedCount += 1;
  }

  // ── Per-number recent (latest call per campaign_number_id, top N) ────
  // calls is already ordered DESC by created_at, so the first occurrence
  // of each campaign_number_id is the most recent call for that number.
  const latestCallByNumber = new Map<string, CallRow>();
  for (const c of calls) {
    if (!latestCallByNumber.has(c.campaign_number_id)) {
      latestCallByNumber.set(c.campaign_number_id, c);
    }
  }
  const numberIds = Array.from(latestCallByNumber.keys()).slice(0, PER_NUMBER_LIMIT);

  let numbersList: NumberBrief[] = [];
  if (numberIds.length > 0) {
    const { data: nums, error: numsErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, campaign_id, phone_e164, outcome, attempt_count, last_attempted_at")
      .in("id", numberIds);
    if (numsErr) {
      console.error("[dashboard/activity] campaign_numbers_v2 query failed:", numsErr);
      // Non-fatal: surface the other panels even if this one fails.
    } else {
      numbersList = (nums ?? []) as unknown as NumberBrief[];
    }
  }

  const perNumberRecent = numbersList
    .map((n) => {
      const lastCall = latestCallByNumber.get(n.id);
      return {
        campaignNumberId: n.id,
        phoneE164: n.phone_e164,
        campaignId: n.campaign_id,
        campaignName: campByID.get(n.campaign_id) ?? "—",
        outcome: n.outcome,
        attemptCount: n.attempt_count,
        lastAttemptedAt: n.last_attempted_at ?? lastCall?.created_at ?? null,
        lastDurationSeconds: lastCall?.duration_seconds ?? null,
        lastStatus: lastCall?.status ?? null,
      };
    })
    .sort((a, b) => {
      const aT = a.lastAttemptedAt ? new Date(a.lastAttemptedAt).getTime() : 0;
      const bT = b.lastAttemptedAt ? new Date(b.lastAttemptedAt).getTime() : 0;
      return bT - aT;
    });

  // ── Recent SMS ───────────────────────────────────────────────────────
  const recentSms = sms.map((s) => ({
    id: s.id,
    createdAt: s.created_at,
    status: s.status,
    toPhoneE164: s.to_phone_e164,
    bodyPreview: s.body.length > 80 ? `${s.body.slice(0, 80)}…` : s.body,
    errorMessage: s.error_message,
    campaignId: s.campaign_id,
    campaignName: campByID.get(s.campaign_id) ?? "—",
  }));

  return NextResponse.json({
    fetchedAt: now.toISOString(),
    recentCalls,
    recentSms,
    outcomes24h: {
      total: calls.length,
      byStatus,
      goalReachedCount,
    },
    perNumberRecent,
  });
}
