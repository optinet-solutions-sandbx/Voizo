import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { computeCallRecords, type DashCallRow, type DashNumberRow } from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/campaigns/[id]/records
 *
 * One record per campaign_number for the expandable Campaign Performance row:
 * phone, derived status, attempt count, last-attempted time. The UI applies the
 * status/date/hour/phone filters + export counts client-side (bounded per campaign).
 * Ghost campaigns return empty. Read-only; lenient origin.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;

  // Verify the campaign exists and is not a ghost run (segregation).
  const { data: camp } = await supabaseAdmin.from("campaigns_v2").select("id, source").eq("id", id).single();
  if (!camp || (camp as { source?: string | null }).source === "ghost_portal") {
    return NextResponse.json({ records: [] });
  }

  // Page past the 1000-row cap so a hot campaign (>1000 numbers/calls) isn't truncated.
  const [numbersData, callsData] = await Promise.all([
    fetchAllRows(supabaseAdmin, "campaign_numbers_v2", "id, phone_e164, outcome", "id", {
      column: "campaign_id",
      value: id,
    }),
    fetchAllRows(
      supabaseAdmin,
      "calls_v2",
      "campaign_id, campaign_number_id, created_at, goal_reached, status, voicemail, duration_seconds, ended_reason, transcript",
      "id",
      { column: "campaign_id", value: id },
    ),
  ]);

  const records = computeCallRecords(
    numbersData as unknown as DashNumberRow[],
    callsData as unknown as DashCallRow[],
  );
  records.sort((a, b) => (b.lastAttemptedMs ?? 0) - (a.lastAttemptedMs ?? 0));

  return NextResponse.json({ records });
}
