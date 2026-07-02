import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { buildExportLeads, type ExportCallRow, type ExportSmsRow, type ExportNumberRow } from "@/lib/exportLeads";

/**
 * GET /api/dashboard/today/export-metadata?day=today|yesterday
 *
 * Day-scoped ExportLeads (recording URLs + transcripts + SMS) for the Today drawer's
 * CSV / Audio / Transcripts export via the shared runExport engine. Cross-campaign; ghost + test
 * excluded; keyed by campaign_number_id so the drawer maps its currently-visible (filtered) contacts.
 * Mirrors today/records' UTC day-window. Read-only, lenient origin, service role. Zero call/SMS cost —
 * audio just streams existing recordings via the proxy.
 */
const MS_PER_DAY = 86_400_000;

export async function GET(request: NextRequest) {
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
  const d = new Date(Date.now());
  const todayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dayStart = day === "yesterday" ? todayStart - MS_PER_DAY : todayStart;
  const startIso = new Date(dayStart).toISOString();
  const endIso = new Date(dayStart + MS_PER_DAY).toISOString();

  // fetchAllRows pages past PostgREST's 1000-row cap (one busy day exceeds it at 1000+
  // calls/day) and degrades-to-partial with a loud server log — same contract as the
  // ranged /export-metadata route.
  const [campaignRows, callRows, smsRows] = await Promise.all([
    fetchAllRows(supabaseAdmin, "campaigns_v2", "id, source, is_test", "id"),
    fetchAllRows(
      supabaseAdmin,
      "calls_v2",
      "campaign_id, campaign_number_id, status, goal_reached, duration_seconds, transcript, recording_url, created_at",
      "id",
      undefined,
      { column: "created_at", value: startIso },
      { column: "created_at", value: endIso },
    ),
    fetchAllRows(
      supabaseAdmin,
      "sms_messages_v2",
      "campaign_id, campaign_number_id, body, status, provider_message_id, error_message, created_at, updated_at",
      "id",
      undefined,
      { column: "created_at", value: startIso },
      { column: "created_at", value: endIso },
    ),
  ]);

  const liveIds = new Set(
    (campaignRows as unknown as Array<{ id: string; source: string | null; is_test: boolean | null }>)
      .filter((c) => c.source !== "ghost_portal" && c.is_test !== true)
      .map((c) => c.id),
  );

  const calls = (callRows as unknown as Array<ExportCallRow & { campaign_id: string }>).filter((c) => liveIds.has(c.campaign_id));
  const sms = (smsRows as unknown as Array<ExportSmsRow & { campaign_id: string }>).filter((m) => liveIds.has(m.campaign_id));

  // Numbers dialed that day → their detail (chunked .in() at 150, same URL-limit guard as today/records).
  const numIds = [...new Set(calls.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  const IN_CHUNK = 150;
  let numbers: ExportNumberRow[] = [];
  for (let i = 0; i < numIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, phone_e164, outcome")
      .in("id", numIds.slice(i, i + IN_CHUNK));
    if (error) {
      console.error("[today/export-metadata] numbers query failed:", error);
      return NextResponse.json({ error: "Failed to read export data" }, { status: 500 });
    }
    numbers = numbers.concat((data ?? []) as ExportNumberRow[]);
  }

  const leadsByNumber = Object.fromEntries(buildExportLeads(numbers, calls, sms));
  return NextResponse.json({ leadsByNumber });
}
