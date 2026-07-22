import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { shapeQueueRows, type QueueRow } from "@/lib/realtimeQueue";

/**
 * GET /api/campaigns-v2/[id]/detail
 *
 * RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md) — vertical slice.
 *
 * Returns the campaign-detail child bundle (numbers + calls + SMS) for the
 * detail page, read SERVER-SIDE via the service role (supabaseAdmin, bypasses
 * RLS). This replaces the page's three anon `.select('*')` reads
 * (fetchCampaignNumbersV2 / fetchCallsV2 / fetchSmsMessagesV2 in
 * campaignV2Data.ts), which used the public anon key and were readable by
 * anyone holding it. Moving them here is the prerequisite for Phase B (dropping
 * the permissive `for all using(true)` policy) without breaking the UI.
 *
 * Auth: this route is NOT in middleware's PUBLIC_PATH_PREFIXES, so it sits
 * behind the dashboard HTTP Basic Auth — i.e. it is auth-gated. Per the locked
 * design decision (2026-06-04), the detail page keeps FULL PII (phone numbers,
 * transcripts, recording URLs, SMS bodies); the auth gate is what protects it,
 * not column redaction. No strict same-origin check on this GET (browsers omit
 * Origin on same-origin GETs — see memory csrf-origin-check-get-lenient); the
 * Basic Auth middleware is the gate.
 *
 * Best-effort per table: a calls/sms query error returns [] for that array
 * (logged) rather than failing the whole bundle — mirrors the page's original
 * `.catch(() => [])` on calls/sms.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  const [numbersRes, callsRes, smsRes] = await Promise.all([
    supabaseAdmin
      .from("campaign_numbers_v2")
      .select("*")
      .eq("campaign_id", id)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("calls_v2")
      .select("*")
      .eq("campaign_id", id)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("sms_messages_v2")
      .select("*")
      .eq("campaign_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (numbersRes.error) console.error(`[campaigns-v2/detail] numbers query failed for ${id}:`, numbersRes.error);
  if (callsRes.error) console.error(`[campaigns-v2/detail] calls query failed for ${id}:`, callsRes.error);
  if (smsRes.error) console.error(`[campaigns-v2/detail] sms query failed for ${id}:`, smsRes.error);

  // Queue (VOZ-186): a realtime child also surfaces its parent's 'waiting'
  // claims — players between signup and dial row (call delay / cap gate),
  // previously invisible until promotion. Read-only over
  // realtime_seen_members; empty array for every non-realtime campaign.
  // Same best-effort rule as the tables above: a queue error logs and
  // returns [], never fails the bundle.
  let queue: QueueRow[] = [];
  const { data: camp } = await supabaseAdmin
    .from("campaigns_v2")
    .select("realtime, parent_campaign_id")
    .eq("id", id)
    .maybeSingle();
  if (camp?.realtime === true && camp.parent_campaign_id) {
    const parentId = camp.parent_campaign_id as string;
    const [parentRes, waitingRes] = await Promise.all([
      supabaseAdmin
        .from("campaigns_v2")
        .select("call_delay_minutes")
        .eq("id", parentId)
        .maybeSingle(),
      supabaseAdmin
        .from("realtime_seen_members")
        .select("cio_id, display_name, phone_e164, first_seen_at")
        .eq("parent_campaign_id", parentId)
        .eq("status", "waiting"),
    ]);
    if (waitingRes.error) {
      console.error(`[campaigns-v2/detail] queue query failed for ${id}:`, waitingRes.error);
    }
    queue = shapeQueueRows(
      waitingRes.data ?? [],
      (parentRes.data?.call_delay_minutes as number | null) ?? null,
    );
  }

  return NextResponse.json({
    numbers: numbersRes.data ?? [],
    calls: callsRes.data ?? [],
    sms: smsRes.data ?? [],
    queue,
  });
}
