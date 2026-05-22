import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { rejectIfCrossOriginStrict } from "@/lib/csrf";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/campaigns-v2/[id]/is-test
 *
 * Toggles a campaign's is_test flag. Used by the detail page header toggle
 * (next to Resume/Refresh segment/Duplicate). The flag excludes the campaign
 * from /api/audience/suggestions output — purely a filter for the proactive
 * suggestion surface; no other behavior changes.
 *
 * Operator autonomy: this endpoint accepts both true and false so operators
 * can flag and unflag freely. The dialer + segment-create flows ignore the
 * flag entirely (it only matters for the suggestions endpoint).
 *
 * Design: docs/2026-05-22_DOC_Audience_Suggestions_MVP.md §5.4
 */

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  let body: { is_test?: unknown };
  try {
    body = (await request.json()) as { is_test?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.is_test !== "boolean") {
    return NextResponse.json(
      { error: "is_test (boolean) is required" },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from("campaigns_v2")
    .update({ is_test: body.is_test })
    .eq("id", id)
    .select("id, is_test")
    .single();

  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Campaign not found" },
      { status: 404 },
    );
  }

  console.log(`[campaigns-v2] is_test updated: campaign=${id} is_test=${body.is_test}`);
  return NextResponse.json({ id: data.id, is_test: data.is_test });
}
