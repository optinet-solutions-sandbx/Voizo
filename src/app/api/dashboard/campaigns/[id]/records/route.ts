import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
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

  const [numbersRes, callsRes] = await Promise.all([
    supabaseAdmin.from("campaign_numbers_v2").select("id, phone_e164, outcome").eq("campaign_id", id),
    supabaseAdmin
      .from("calls_v2")
      .select("campaign_id, campaign_number_id, created_at, goal_reached, status")
      .eq("campaign_id", id),
  ]);

  if (numbersRes.error || callsRes.error) {
    console.error("[dashboard/campaigns/records] query failed:", numbersRes.error ?? callsRes.error);
    return NextResponse.json({ error: "Failed to read call records" }, { status: 500 });
  }

  const records = computeCallRecords(
    (numbersRes.data ?? []) as unknown as DashNumberRow[],
    (callsRes.data ?? []) as unknown as DashCallRow[],
  );
  records.sort((a, b) => (b.lastAttemptedMs ?? 0) - (a.lastAttemptedMs ?? 0));

  return NextResponse.json({ records });
}
