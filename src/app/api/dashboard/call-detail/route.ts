import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { audioUrlFor, transcriptText } from "@/lib/labelData";

/**
 * GET /api/dashboard/call-detail?numberId=<campaign_number_id>
 *
 * Every call ATTEMPT for one contact (a campaign_number), each with a playable audio URL +
 * normalized transcript — for the per-contact detail modal opened from the records tables.
 * Ordered chronologically (Attempt 1 first). Read-only; lenient origin (matches the other
 * dashboard GETs); service role. Zero call/SMS cost — recordings already exist; the audio URL
 * is the same-origin recordings proxy (reused from the reviews queue).
 */
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

  const numberId = new URL(request.url).searchParams.get("numberId");
  if (!numberId) return NextResponse.json({ error: "numberId is required" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("calls_v2")
    .select("id, created_at, duration_seconds, status, goal_reached, transcript, recording_url")
    .eq("campaign_number_id", numberId)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[dashboard/call-detail] query failed:", error);
    return NextResponse.json({ error: "Failed to load call detail" }, { status: 500 });
  }

  const attempts = (data ?? []).map((c) => ({
    callId: c.id as string,
    createdAt: c.created_at as string | null,
    durationSeconds: (c.duration_seconds as number | null) ?? null,
    status: (c.status as string | null) ?? "",
    goalReached: (c.goal_reached as boolean | null) ?? null,
    transcript: transcriptText(c.transcript),
    audioUrl: audioUrlFor(c.recording_url),
  }));

  return NextResponse.json({ attempts });
}
