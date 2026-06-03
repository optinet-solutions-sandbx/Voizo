import { NextRequest, NextResponse } from "next/server";
import { listReviewCampaigns } from "@/lib/labelData";

/**
 * GET /api/reviews/campaigns?testOnly=true|false
 *
 * Per-campaign aggregate for the Reviews landing list: real-conversation count,
 * goal-reached count, and this reviewer's labeled count. Read-only → lenient
 * origin check (matches /api/dashboard/activity). Service-role reads only.
 */

// v1: single shared operator identity from the Basic-Auth user (per-reviewer
// identity arrives with real auth — Phase 2 Supabase Auth).
function reviewerFrom(): string {
  return process.env.DASHBOARD_USERNAME || "operator";
}

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

  const testOnly = new URL(request.url).searchParams.get("testOnly") === "true";

  try {
    const campaigns = await listReviewCampaigns({ labeledBy: reviewerFrom(), testOnly });
    return NextResponse.json({ campaigns, reviewer: reviewerFrom() });
  } catch (err) {
    console.error("[reviews/campaigns] failed:", err);
    return NextResponse.json({ error: "Failed to load review campaigns" }, { status: 500 });
  }
}
