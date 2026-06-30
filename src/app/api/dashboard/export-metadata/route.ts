import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  buildCampaignIndex,
  filterCalls,
  computeCallRecords,
  type DashCallRow,
  type DashCampaignRow,
  type DashNumberRow,
} from "@/lib/dashboardAnalytics";
import { resolvePromptByCampaign } from "@/lib/promptResolution";
import { parseRecordsParams, filterRecordsBySlice, FULL_SET_CAP } from "@/lib/rangedRecords";
import { buildExportLeads, type ExportCallRow, type ExportNumberRow, type ExportSmsRow } from "@/lib/exportLeads";

/**
 * GET /api/dashboard/export-metadata
 *
 * Cross-campaign ExportLeads for the Global drawer's CSV / Audio / Transcripts export (Slice B2).
 * Same validated filters + slice as /api/dashboard/records, but returns the heavier ExportLead shape
 * (attempts with transcript text + recording URL, SMS bodies) for the client-side export engine.
 *
 * The slice filter uses the LEAN classifier (computeCallRecords {useTranscript:false} +
 * filterRecordsBySlice) so the export set == the drawer's visible set (reconciles with B1). Transcript
 * / recording_url / SMS body are pulled here ONLY because this is the explicit, operator-triggered
 * export path (capped at FULL_SET_CAP, behind Basic Auth) — never in the always-on aggregate routes.
 * Zero-Trust params, least-disclosure errors, structured log. Read-only, lenient origin (GET).
 */
const MS_PER_DAY = 86_400_000;
const IN_CHUNK = 150;

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

  const now = Date.now();
  const p = parseRecordsParams(new URL(request.url).searchParams);
  const startMs = now - p.rangeDays * MS_PER_DAY;
  const startIso = new Date(startMs).toISOString();

  try {
    let numberIds: string[] | null = null;
    if (p.phone) {
      const { data: nums } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("id")
        .ilike("phone_e164", `%${p.phone}%`)
        .limit(2000);
      numberIds = (nums ?? []).map((n) => n.id as string);
    }

    // Windowed calls WITH transcript + recording_url (export path) + all campaigns. Paged.
    const [callRows, campaignRows] = await Promise.all([
      fetchAllRows(
        supabaseAdmin,
        "calls_v2",
        "id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds, transcript, recording_url",
        "id",
        undefined,
        { column: "created_at", value: startIso },
      ),
      fetchAllRows(
        supabaseAdmin,
        "campaigns_v2",
        "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, system_prompt, start_at, created_at, end_at, timezone",
        "id",
      ),
    ]);

    const campaigns = campaignRows as unknown as (DashCampaignRow & { system_prompt?: string | null })[];
    const index = buildCampaignIndex(campaigns);
    const live = campaigns.filter((c) => c.source !== "ghost_portal" && c.is_test !== true);
    const liveIdSet = new Set(live.map((c) => c.id));

    let filtered = filterCalls(
      callRows as unknown as DashCallRow[],
      { startMs, endMs: now, campaignIds: p.campaignIds, voiceId: p.agent, numberIds },
      index,
    );
    if (p.promptSha) {
      const promptByCampaign = await resolvePromptByCampaign(live);
      filtered = filtered.filter((c) => promptByCampaign.get(c.campaign_id)?.sha === p.promptSha);
    }

    // Contacts referenced by the filtered calls (chunked .in() 150).
    const numIds = [...new Set(filtered.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
    let numbers: DashNumberRow[] = [];
    for (let i = 0; i < numIds.length; i += IN_CHUNK) {
      const { data, error } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("id, phone_e164, outcome")
        .in("id", numIds.slice(i, i + IN_CHUNK));
      if (error) {
        console.error("[dashboard/export-metadata] numbers query failed:", error);
        return NextResponse.json({ error: "Failed to read export data" }, { status: 500 });
      }
      numbers = numbers.concat((data ?? []) as unknown as DashNumberRow[]);
    }

    // SMS for the window (bodies for the export + the sent/delivered set for the smsOnly slice). Paged.
    const smsRows = (await fetchAllRows(
      supabaseAdmin,
      "sms_messages_v2",
      "campaign_id, campaign_number_id, status, body, provider_message_id, error_message, created_at, updated_at",
      "id",
      undefined,
      { column: "created_at", value: startIso },
    )) as unknown as (ExportSmsRow & { campaign_id: string })[];
    const smsIds = new Set(
      smsRows
        .filter((m) => (m.status === "sent" || m.status === "delivered") && liveIdSet.has(m.campaign_id) && !!m.campaign_number_id)
        .map((m) => m.campaign_number_id as string),
    );

    // Lean classifier for the slice filter → matches the drawer exactly. Sort by last-attempted desc.
    const sliced = filterRecordsBySlice(
      computeCallRecords(numbers, filtered, { useTranscript: false }).sort(
        (a, b) => (b.lastAttemptedMs ?? 0) - (a.lastAttemptedMs ?? 0),
      ),
      p,
      smsIds,
    );
    const total = sliced.length;
    const truncated = total > FULL_SET_CAP;
    const matchingIds = sliced.slice(0, FULL_SET_CAP).map((r) => r.campaignNumberId);
    const matchingSet = new Set(matchingIds);

    // Build export detail ONLY for the matching contacts (parsimony), preserving the sorted order.
    const byId = buildExportLeads(
      numbers.filter((n) => matchingSet.has(n.id)) as ExportNumberRow[],
      filtered as unknown as ExportCallRow[],
      smsRows,
    );
    const leads = matchingIds.map((id) => byId.get(id)).filter((l): l is NonNullable<typeof l> => !!l);

    console.log(
      "[dashboard/export-metadata]",
      JSON.stringify({
        range: `${p.rangeDays}d`,
        status: p.status,
        outcome: p.outcome,
        smsOnly: p.smsOnly,
        totalContacts: total,
        returned: leads.length,
        truncated,
        ms: Date.now() - now,
      }),
    );
    if (truncated) {
      console.warn(`[dashboard/export-metadata] truncated to ${FULL_SET_CAP} of ${total} contacts — narrow the filter`);
    }

    return NextResponse.json({ leads, total, truncated, cap: FULL_SET_CAP });
  } catch (e) {
    console.error("[dashboard/export-metadata] failed:", e);
    return NextResponse.json({ error: "Failed to read export data" }, { status: 500 });
  }
}
