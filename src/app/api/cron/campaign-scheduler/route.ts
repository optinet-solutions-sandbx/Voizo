import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { findNextNumber, fireCall, isWithinCallWindow } from "@/lib/dialer";
import crypto from "crypto";

// FS bgapi originate takes 8-22s per call. With 60s budget and limit(2),
// we can safely start 2 campaigns per cron tick. Remaining campaigns are
// picked up on the next tick (1 minute later).
export const maxDuration = 60;

/**
 * GET /api/cron/campaign-scheduler
 *
 * Vercel Cron job — runs every minute.
 *
 * Finds campaigns with status='draft', a non-null start_at that has arrived,
 * and auto-starts them. This is the executor half of scheduling; the guard
 * half lives in the /start endpoint (rejects manual Start when start_at is
 * in the future).
 *
 * Security: Vercel injects an Authorization header with CRON_SECRET on
 * cron-triggered requests. We verify it to prevent external triggers.
 *
 * Idempotency: atomic status transition (draft → running) with a WHERE
 * clause prevents double-start if two cron ticks overlap.
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[campaign-scheduler] CRON_SECRET not set — rejecting");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const expected = `Bearer ${cronSecret}`;
  const received = authHeader || "";
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Find campaigns ready to auto-start ──
  const now = new Date().toISOString();

  const { data: campaigns, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("status", "draft")
    .not("start_at", "is", null)
    .lte("start_at", now)
    .limit(2); // cap per tick — fireCall takes 8-22s, maxDuration is 60s

  if (error) {
    console.error("[campaign-scheduler] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!campaigns || campaigns.length === 0) {
    return NextResponse.json({ started: 0 });
  }

  const results: Array<{ id: string; name: string; result: string }> = [];

  for (const campaign of campaigns) {
    const campaignId = campaign.id as string;
    const campaignName = campaign.name as string;

    // ── Call window check ──
    const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
    const timezone = campaign.timezone as string;
    if (callWindows && callWindows.length > 0 && !isWithinCallWindow(callWindows, timezone)) {
      console.log(`[campaign-scheduler] ${campaignName}: inside start_at window but outside call window — skipping`);
      results.push({ id: campaignId, name: campaignName, result: "outside_call_window" });
      continue;
    }

    // ── Atomic status transition (draft → running) ──
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("campaigns_v2")
      .update({ status: "running" })
      .eq("id", campaignId)
      .eq("status", "draft")
      .select("id")
      .single();

    if (updateErr || !updated) {
      results.push({ id: campaignId, name: campaignName, result: "already_started" });
      continue;
    }

    // ── Find next number and fire first call ──
    const nextNumber = await findNextNumber(campaignId);
    if (!nextNumber) {
      await supabaseAdmin
        .from("campaigns_v2")
        .update({ status: "completed" })
        .eq("id", campaignId);
      results.push({ id: campaignId, name: campaignName, result: "no_eligible_numbers" });
      continue;
    }

    try {
      const host = request.headers.get("host") || "voizo-eight.vercel.app";
      const proto = request.headers.get("x-forwarded-proto") || "https";
      const baseUrl = `${proto}://${host}`;

      await fireCall(
        campaignId,
        nextNumber,
        campaign.vapi_assistant_id as string,
        baseUrl,
        (campaign.vapi_sip_uri as string) ?? undefined,
      );

      console.log(`[campaign-scheduler] ${campaignName}: auto-started → dialing ${nextNumber.phone_e164.slice(0, -4)}****`);
      results.push({ id: campaignId, name: campaignName, result: "started" });
    } catch (err) {
      console.error(`[campaign-scheduler] ${campaignName}: fireCall failed:`, err);
      // Don't leave campaign running with no active call
      await supabaseAdmin
        .from("campaigns_v2")
        .update({ status: "paused" })
        .eq("id", campaignId);
      results.push({ id: campaignId, name: campaignName, result: "fire_failed" });
    }
  }

  return NextResponse.json({ started: results.filter((r) => r.result === "started").length, results });
}
