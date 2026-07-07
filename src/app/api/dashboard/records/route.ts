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
import { parseRecordsParams, filterRecordsBySlice, paginate, FULL_SET_CAP } from "@/lib/rangedRecords";
import { campaignIdsForCountry } from "@/lib/campaignDisplay";

/**
 * GET /api/dashboard/records
 *
 * Ranged, filtered, PAGINATED per-contact records for the Global Performance drill-down drawer
 * (Slice B). Honors the same filters as /api/dashboard/analytics (range · campaigns · agent ·
 * prompt · phone) PLUS the clicked slice (status · outcome · smsOnly), then aggregates to contacts
 * with the LEAN (transcript-less) classifier so the drawer reconciles with the ranged cards.
 *
 * Zero-Trust: every param is validated/clamped in parseRecordsParams. No transcript / SMS body in
 * the response (PII parsimony) — phone only (operator-facing, behind Basic Auth). Lazy: only hit on
 * a card/row click. Read-only, lenient origin (GET). Least-disclosure errors.
 */
const MS_PER_DAY = 86_400_000;
const IN_CHUNK = 150; // PostgREST ~16KB URL header guard

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
    // Phone lookup → matching number ids (bounds the call set). Mirrors the analytics route.
    let numberIds: string[] | null = null;
    if (p.phone) {
      const { data: nums } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("id")
        .ilike("phone_e164", `%${p.phone}%`)
        .limit(2000);
      numberIds = (nums ?? []).map((n) => n.id as string);
    }

    // Windowed calls (NO transcript — lean) + all campaigns (index + prompt resolution). Paged.
    const [callRows, campaignRows] = await Promise.all([
      fetchAllRows(
        supabaseAdmin,
        "calls_v2",
        "id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds",
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

    // Filter by range/campaign/agent/phone (same as analytics) + prompt (shared resolver, lazy).
    let filtered = filterCalls(
      callRows as unknown as DashCallRow[],
      { startMs, endMs: now, campaignIds: p.campaignIds, voiceId: p.agent, baseAssistantId: p.baseAgent, numberIds },
      index,
    );
    if (p.country) {
      const countryIds = campaignIdsForCountry(live, p.country);
      filtered = filtered.filter((c) => countryIds.has(c.campaign_id));
    }
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
        console.error("[dashboard/records] numbers query failed:", error);
        return NextResponse.json({ error: "Failed to read records" }, { status: 500 });
      }
      numbers = numbers.concat((data ?? []) as unknown as DashNumberRow[]);
    }

    // SMS-texted contacts in the window (only fetched when the slice needs it — parsimony). Paged.
    let smsIds = new Set<string>();
    if (p.smsOnly) {
      const smsRows = await fetchAllRows(
        supabaseAdmin,
        "sms_messages_v2",
        "campaign_id, campaign_number_id, status, created_at",
        "id",
        undefined,
        { column: "created_at", value: startIso },
      );
      smsIds = new Set(
        (smsRows as unknown as { campaign_id: string; campaign_number_id: string | null; status: string | null }[])
          .filter((m) => (m.status === "sent" || m.status === "delivered") && liveIdSet.has(m.campaign_id) && !!m.campaign_number_id)
          .map((m) => m.campaign_number_id as string),
      );
    }

    // Aggregate to contacts (lean classifier → reconciles with the ranged cards), slice, sort, page.
    const allRecords = computeCallRecords(numbers, filtered, { useTranscript: false }).sort(
      (a, b) => (b.lastAttemptedMs ?? 0) - (a.lastAttemptedMs ?? 0),
    );
    const sliced = filterRecordsBySlice(allRecords, p, smsIds);
    const { page, total } = paginate(sliced, p.offset, p.limit);
    const truncated = p.full && total > FULL_SET_CAP;

    console.log(
      "[dashboard/records]",
      JSON.stringify({
        range: `${p.rangeDays}d`,
        status: p.status,
        outcome: p.outcome,
        smsOnly: p.smsOnly,
        totalCalls: filtered.length,
        totalContacts: total,
        returned: page.length,
        full: p.full,
        truncated,
        ms: Date.now() - now,
      }),
    );
    if (truncated) {
      console.warn(`[dashboard/records] full-set truncated to ${FULL_SET_CAP} of ${total} contacts — narrow the filter`);
    }

    return NextResponse.json({ records: page, total, truncated, cap: FULL_SET_CAP });
  } catch (e) {
    console.error("[dashboard/records] failed:", e);
    return NextResponse.json({ error: "Failed to read records" }, { status: 500 });
  }
}
