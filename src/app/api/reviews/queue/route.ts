import { NextRequest, NextResponse } from "next/server";
import { listReviewQueue } from "@/lib/labelData";

/**
 * GET /api/reviews/queue
 *
 * Calls to review for the Reviews tab, each with this reviewer's existing label.
 * Query params: campaignId?, testOnly=true|false, limit?, offset?.
 *
 * Read-only → lenient origin check (matches /api/dashboard/activity).
 * Behind the Basic-Auth middleware; reads via service role (call_labels is
 * default-deny to the anon key).
 */

// v1: single shared operator identity from the Basic-Auth user. Per-reviewer
// identity arrives with real auth (Phase 2 Supabase Auth).
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

  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId") || undefined;
  const testOnly = searchParams.get("testOnly") === "true";

  try {
    const { items, total } = await listReviewQueue({
      labeledBy: reviewerFrom(),
      campaignId,
      testOnly,
    });
    return NextResponse.json({ items, total, reviewer: reviewerFrom() });
  } catch (err) {
    console.error("[reviews/queue] failed:", err);
    return NextResponse.json({ error: "Failed to load review queue" }, { status: 500 });
  }
}
