import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  computeCallRecords,
  attachSmsSent,
  parsePreviewDate,
  type DashCallRow,
  type DashNumberRow,
} from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/today/records?day=today|yesterday
 *
 * Per-contact call records for ONE UTC day, powering the Today's Performance drill-down drawer
 * (3-card redesign, Val's mockup 2026-06-29). One record per campaign_number that was DIALED that
 * day, with `smsSentToday` flagging contacts that also got a sent|delivered text that day (so the
 * SMS card can drill into texted contacts). Ghost + test campaigns excluded.
 *
 * NOTE: the number set is the day's CALL set. A text sent today to a contact whose call was on an
 * earlier day won't appear here — rare in practice (registered_optin texts fire right after the
 * call, same day), and a known small gap vs the SMS card total. Read-only, lenient origin policy.
 */
const MS_PER_DAY = 86_400_000;

type LiveCampaignRow = { id: string; source: string | null; is_test: boolean | null };
type SmsRow = { campaign_id: string; campaign_number_id: string | null; status: string | null; created_at: string | null };

export async function GET(request: NextRequest) {
  // Lenient origin check (GET — same policy as /api/dashboard/today).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const day = request.nextUrl.searchParams.get("day") === "yesterday" ? "yesterday" : "today";
  // Dev preview: ?date=YYYY-MM-DD makes that date "today" (matches the today route's override).
  const now = parsePreviewDate(request.nextUrl.searchParams.get("date")) ?? Date.now();
  const d = new Date(now);
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayStart = day === "yesterday" ? todayStart - MS_PER_DAY : todayStart;
  const startIso = new Date(dayStart).toISOString();
  const endIso = new Date(dayStart + MS_PER_DAY).toISOString();

  const [campaignsRes, callsRes] = await Promise.all([
    supabaseAdmin.from("campaigns_v2").select("id, source, is_test"),
    supabaseAdmin
      .from("calls_v2")
      .select("id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds, transcript")
      .gte("created_at", startIso)
      .lt("created_at", endIso),
  ]);
  if (campaignsRes.error || callsRes.error) {
    console.error("[dashboard/today/records] query failed:", campaignsRes.error ?? callsRes.error);
    return NextResponse.json({ error: "Failed to read today's records" }, { status: 500 });
  }

  const liveIds = new Set(
    ((campaignsRes.data ?? []) as unknown as LiveCampaignRow[])
      .filter((c) => c.source !== "ghost_portal" && c.is_test !== true)
      .map((c) => c.id),
  );
  const calls = ((callsRes.data ?? []) as unknown as DashCallRow[]).filter((c) => liveIds.has(c.campaign_id));

  // Contacts dialed that day → fetch their campaign_numbers_v2 rows (chunked).
  const numIds = [...new Set(calls.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  // Chunk the .in() so the URL stays under PostgREST's ~16KB header limit (matches the today route).
  const IN_CHUNK = 150;
  let numbers: DashNumberRow[] = [];
  for (let i = 0; i < numIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, phone_e164, outcome")
      .in("id", numIds.slice(i, i + IN_CHUNK));
    if (error) {
      console.error("[dashboard/today/records] numbers query failed:", error);
      return NextResponse.json({ error: "Failed to read today's records" }, { status: 500 });
    }
    numbers = numbers.concat((data ?? []) as unknown as DashNumberRow[]);
  }

  // Contacts that got a sent|delivered text that day (live campaigns only).
  const smsRes = await supabaseAdmin
    .from("sms_messages_v2")
    .select("campaign_id, campaign_number_id, status, created_at")
    .gte("created_at", startIso)
    .lt("created_at", endIso);
  if (smsRes.error) {
    console.error("[dashboard/today/records] sms query failed:", smsRes.error);
    return NextResponse.json({ error: "Failed to read today's records" }, { status: 500 });
  }
  const sentNumberIds = new Set(
    ((smsRes.data ?? []) as unknown as SmsRow[])
      .filter((m) => (m.status === "sent" || m.status === "delivered") && liveIds.has(m.campaign_id) && !!m.campaign_number_id)
      .map((m) => m.campaign_number_id as string),
  );

  const records = attachSmsSent(computeCallRecords(numbers, calls), sentNumberIds);
  return NextResponse.json({ records });
}
