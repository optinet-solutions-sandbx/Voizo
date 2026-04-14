import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { findNextNumber, fireCall, isWithinCallWindow } from "@/lib/dialer";

/**
 * POST /api/campaigns-v2/[id]/start
 *
 * Starts (or resumes) a Campaign V2.
 *
 * Manifesto compliance:
 * - Call window checked before first dial
 * - Suppression checked inside findNextNumber
 * - Concurrency guard: only draft/paused → running transition allowed
 * - State written to DB before calling Twilio
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Fetch campaign
  const { data: campaign, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (campaign.status !== "draft" && campaign.status !== "paused") {
    return NextResponse.json(
      { error: `Cannot start campaign with status "${campaign.status}"` },
      { status: 400 },
    );
  }

  // ── Call window check (Manifesto §6: check before every dial) ──
  const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
  if (callWindows && callWindows.length > 0 && !isWithinCallWindow(callWindows, campaign.timezone)) {
    return NextResponse.json(
      { error: "Outside call window. Campaign cannot start dialing right now." },
      { status: 400 },
    );
  }

  // ── Concurrency guard (H2): atomic status transition ──
  // Only update if status is still draft/paused (prevents double-click race)
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update({ status: "running" })
    .eq("id", id)
    .in("status", ["draft", "paused"])
    .select()
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Campaign already running or completed (concurrent start detected)" },
      { status: 409 },
    );
  }

  // Find next eligible number
  const nextNumber = await findNextNumber(id);
  if (!nextNumber) {
    await supabaseAdmin
      .from("campaigns_v2")
      .update({ status: "completed" })
      .eq("id", id);
    return NextResponse.json({ message: "No eligible numbers to dial. Campaign completed." });
  }

  const baseUrl = getBaseUrl(request);

  try {
    const callRow = await fireCall(id, nextNumber, campaign.vapi_assistant_id, baseUrl);
    return NextResponse.json({
      message: "Campaign started. First call fired.",
      callId: callRow.id,
      phone: nextNumber.phone_e164,
    });
  } catch (err) {
    console.error("Failed to fire call:", err);
    // Don't leave campaign in "running" with no active call
    await supabaseAdmin
      .from("campaigns_v2")
      .update({ status: "paused" })
      .eq("id", id);
    return NextResponse.json({ error: "Failed to start dialing. Campaign paused." }, { status: 500 });
  }
}

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}
