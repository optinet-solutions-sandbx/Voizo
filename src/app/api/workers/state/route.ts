import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET /api/workers/state
 *
 * Read-only snapshot of the SIP pool, formatted for the Workers dashboard's
 * 5-second polling loop (design doc §5.2). Returns all 5 slots regardless of
 * status — free slots come back as "anonymous" (no city/timezone), leased
 * slots carry their campaign's metadata so the UI can derive city + UTC offset
 * client-side via Intl.DateTimeFormat.
 *
 * No side effects.
 *
 * Response shape (see design doc §5.2 and §7.1):
 *   {
 *     fetchedAt: string,
 *     slots: [{
 *       slotIndex, slotLabel, status, sipUri,
 *       leasedAt, leasedDurationMs,
 *       campaign:    { id, name, status, timezone, vapiAssistantName } | null,
 *       inFlightCall:{ callId, vapiCallId, phoneE164, status, startedAt, durationMs } | null,
 *       notes
 *     }, ...]
 *   }
 *
 * CSRF/origin policy: read-only, so the origin check is lenient — if Origin
 * is present we enforce exact-host match; if absent (browsers omit Origin on
 * many same-origin GETs) we allow the request. OWASP CSRF guidance applies
 * to state-changing requests, not reads. See
 * feedback_csrf_origin_check_get_lenient.
 *
 * Cost note: design doc §11.1 calls this out as negligible (~5.76 MB
 * egress/day per operator viewing at 5s polling). Three Supabase queries
 * per call, only two of which run when at least one slot is leased.
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.2
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §8
 */

const ACTIVE_CALL_STATUSES = ["initiated", "ringing", "in_progress", "answered"];

interface SlotRow {
  id: string;
  slot_index: number;
  sip_uri: string;
  status: string;
  current_assistant_id: string | null;
  current_campaign_id: string | null;
  leased_at: string | null;
  notes: string | null;
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  timezone: string;
  vapi_assistant_name: string | null;
}

interface CallRow {
  id: string;
  campaign_id: string;
  vapi_call_id: string | null;
  status: string;
  answered_at: string | null;
  created_at: string;
  // Supabase-style FK embed (calls_v2.campaign_number_id → campaign_numbers_v2.id)
  campaign_numbers_v2: { phone_e164: string } | { phone_e164: string }[] | null;
}

export async function GET(request: NextRequest) {
  // ── Origin check (lenient on GET — see header comment) ──
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const now = new Date();
  const fetchedAt = now.toISOString();
  const nowMs = now.getTime();

  // ── Q1: every slot, ordered. Always runs. ──
  // Single string literal for select to keep Supabase TS inference happy
  // (per feedback_supabase_select_single_literal).
  const { data: slots, error: slotsErr } = await supabaseAdmin
    .from("vapi_sip_pool")
    .select("id, slot_index, sip_uri, status, current_assistant_id, current_campaign_id, leased_at, notes")
    .order("slot_index", { ascending: true });

  if (slotsErr || !slots) {
    console.error(`[workers/state] vapi_sip_pool query failed:`, slotsErr);
    return NextResponse.json({ error: "Failed to read SIP pool" }, { status: 500 });
  }

  const slotRows = slots as unknown as SlotRow[];

  // Collect leased-campaign IDs for the parallel sub-queries.
  const leasedCampaignIds = slotRows
    .filter((s) => s.status === "leased" && s.current_campaign_id)
    .map((s) => s.current_campaign_id as string);

  // ── Q2 + Q3 in parallel (only if at least one slot is leased) ──
  let campaignsById = new Map<string, CampaignRow>();
  let activeCallsByCampaign = new Map<string, CallRow>();

  if (leasedCampaignIds.length > 0) {
    const [campaignsRes, callsRes] = await Promise.all([
      supabaseAdmin
        .from("campaigns_v2")
        .select("id, name, status, timezone, vapi_assistant_name")
        .in("id", leasedCampaignIds),
      supabaseAdmin
        .from("calls_v2")
        .select("id, campaign_id, vapi_call_id, status, answered_at, created_at, campaign_numbers_v2!campaign_number_id(phone_e164)")
        .in("campaign_id", leasedCampaignIds)
        .in("status", ACTIVE_CALL_STATUSES),
    ]);

    if (campaignsRes.error) {
      console.error(`[workers/state] campaigns_v2 query failed:`, campaignsRes.error);
      return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
    }
    if (callsRes.error) {
      console.error(`[workers/state] calls_v2 query failed:`, callsRes.error);
      return NextResponse.json({ error: "Failed to read in-flight calls" }, { status: 500 });
    }

    for (const c of (campaignsRes.data ?? []) as unknown as CampaignRow[]) {
      campaignsById.set(c.id, c);
    }
    // If multiple active calls exist for the same campaign (shouldn't happen
    // with queue-gate=1 per campaign, but defensive), keep the most recent.
    for (const call of (callsRes.data ?? []) as unknown as CallRow[]) {
      const existing = activeCallsByCampaign.get(call.campaign_id);
      if (!existing || new Date(call.created_at) > new Date(existing.created_at)) {
        activeCallsByCampaign.set(call.campaign_id, call);
      }
    }
  }

  // ── Assemble the response slots ──
  const responseSlots = slotRows.map((s) => {
    const slotLabel = `voizo-sip-pool-slot-${String(s.slot_index).padStart(2, "0")}`;
    const leasedDurationMs =
      s.leased_at && s.status === "leased"
        ? Math.max(0, nowMs - new Date(s.leased_at).getTime())
        : null;

    let campaign: {
      id: string;
      name: string;
      status: string;
      timezone: string;
      vapiAssistantName: string | null;
    } | null = null;
    let inFlightCall: {
      callId: string;
      vapiCallId: string | null;
      phoneE164: string | null;
      status: string;
      startedAt: string;
      durationMs: number;
    } | null = null;

    if (s.status === "leased" && s.current_campaign_id) {
      const c = campaignsById.get(s.current_campaign_id);
      if (c) {
        campaign = {
          id: c.id,
          name: c.name,
          status: c.status,
          timezone: c.timezone,
          vapiAssistantName: c.vapi_assistant_name,
        };
      }

      const call = activeCallsByCampaign.get(s.current_campaign_id);
      if (call) {
        // Supabase returns FK-embedded relations as either an object or an
        // array depending on cardinality detection. Normalize to the first
        // element (a call has exactly one campaign_number_id).
        const phoneObj = Array.isArray(call.campaign_numbers_v2)
          ? call.campaign_numbers_v2[0] ?? null
          : call.campaign_numbers_v2;
        const startedAtIso = call.answered_at ?? call.created_at;
        inFlightCall = {
          callId: call.id,
          vapiCallId: call.vapi_call_id,
          phoneE164: phoneObj?.phone_e164 ?? null,
          status: call.status,
          startedAt: startedAtIso,
          durationMs: Math.max(0, nowMs - new Date(startedAtIso).getTime()),
        };
      }
    }

    return {
      slotIndex: s.slot_index,
      slotLabel,
      status: s.status,
      sipUri: s.sip_uri,
      leasedAt: s.leased_at,
      leasedDurationMs,
      campaign,
      inFlightCall,
      notes: s.notes,
    };
  });

  return NextResponse.json({
    fetchedAt,
    slots: responseSlots,
  });
}
