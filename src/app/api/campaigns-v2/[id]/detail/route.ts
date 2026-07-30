import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { shapeQueueRows, type QueueRow } from "@/lib/realtimeQueue";
import { fetchAllRows, sortRowsByCreatedAt } from "@/lib/supabaseFetchAll";

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

  // Paged reads (fetchAllRows): a bare .select() is clamped by PostgREST at
  // 1000 rows — max-rows clamps EVERYTHING, including explicit ranges (measured
  // 2026-07-30: the 2,058-number CA reactivation child rendered as "1000
  // numbers, 238 done" while 1,058 pending rows were invisible). Paging must
  // order by unique id (bulk imports share created_at); each table's original
  // response order is re-applied below. Error contract unchanged: fetchAllRows
  // is best-effort per table (logs loudly, returns what it got) — same
  // degrade-to-partial the bare reads had.
  const [numbersAll, callsAll, smsAll] = await Promise.all([
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "*", "id", { column: "campaign_id", value: id }),
    fetchAllRows(supabaseAdmin, "calls_v2", "*", "id", { column: "campaign_id", value: id }),
    fetchAllRows(supabaseAdmin, "sms_messages_v2", "*", "id", { column: "campaign_id", value: id }),
  ]);
  const numbers = sortRowsByCreatedAt(numbersAll, "asc");
  const calls = sortRowsByCreatedAt(callsAll, "desc");
  const sms = sortRowsByCreatedAt(smsAll, "desc");

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
    // Same clamp applies here (2,072 seen rows exist for the CA parent — a
    // fully-waiting day would truncate). cio_id is unique within one parent,
    // so it is the stable paging key; shapeQueueRows sorts oldest-first itself.
    const [parentRes, waitingRows] = await Promise.all([
      supabaseAdmin
        .from("campaigns_v2")
        .select("call_delay_minutes")
        .eq("id", parentId)
        .maybeSingle(),
      fetchAllRows(supabaseAdmin, "realtime_seen_members", "cio_id, display_name, phone_e164, first_seen_at", "cio_id", [
        { column: "parent_campaign_id", value: parentId },
        { column: "status", value: "waiting" },
      ]),
    ]);
    queue = shapeQueueRows(
      waitingRows,
      (parentRes.data?.call_delay_minutes as number | null) ?? null,
    );
  }

  return NextResponse.json({
    numbers,
    calls,
    sms,
    queue,
  });
}
