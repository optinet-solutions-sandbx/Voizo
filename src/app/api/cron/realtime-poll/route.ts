import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { isWithinCallWindow } from "@/lib/dialer";
import {
  alertChildOnceDeduped,
  pollRealtimeParent,
  type PollSummary,
  type RealtimeParentRow,
} from "@/lib/scheduler/realtimePoll";
import { CRON_NAMES, postSlackNote, recordHeartbeat } from "@/lib/alerts/slack";
import crypto from "crypto";

// Membership pages + capped profile lookups (~10-15s worst case per parent at
// the 100-lookup cap) + a handful of PostgREST calls. 3 parents fit in 60s;
// a parent that can't finish simply catches up next tick (poll is stateless).
export const maxDuration = 60;

/** "Real-time stopped being real-time" threshold (spec item 6): the oldest
 *  still-pending player has waited this long INSIDE an open call window. */
const FALLEN_BEHIND_MINUTES = parseInt(process.env.REALTIME_FALLEN_BEHIND_MINUTES ?? "15", 10);

/**
 * GET /api/cron/realtime-poll
 *
 * Vercel Cron — every minute (VOZ-132, spec §5). For each realtime parent
 * (campaign_type='recurring', status='running', realtime=true):
 *   1. pollRealtimeParent — diff Customer.io membership vs the seen-table,
 *      admit new members (country + daily cap), queue them into today's child.
 *   2. Fallen-behind alarm — oldest pending player's wait inside an OPEN
 *      window > threshold → deduped Slack WARN.
 *   3. Hourly Slack rollup at minute 0 — "+N new this hour, M called, K waiting"
 *      (spec item 5: minute-by-minute checking stays silent, ops sees hourly).
 *
 * Dormant by construction: with no realtime parents (today's prod) the tick is
 * one SELECT + a heartbeat. Pre-migration the parents query errors on the
 * missing `realtime` column → logged, empty tick, no throw (deploy-order safe).
 *
 * Security: same CRON_SECRET bearer + constant-time compare as sibling crons.
 * Cost: Customer.io ~1-2 membership requests/min/parent (10 req/s cap is acct-
 * wide but these are tiny); profile lookups bounded at 100/tick/parent; zero
 * Vapi/SquareTalk/Mobivate spend from this route (dialing stays in the
 * campaign-scheduler).
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[realtime-poll] CRON_SECRET not set — rejecting");
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

  // ── Realtime parents (select * — deploy-order safe for reads; the .eq on a
  //    pre-migration column errors → empty no-op tick, never a throw) ──
  const { data: parents, error: parentsErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("campaign_type", "recurring")
    .eq("status", "running")
    .eq("realtime", true);

  if (parentsErr) {
    console.warn("[realtime-poll] parents query failed (pre-migration is expected to land here):", parentsErr.message);
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.realtimePoll);
    return NextResponse.json({ parents: 0, note: "parents query failed — see logs" });
  }

  const now = new Date();
  const results: Array<{ parentId: string; parentName: string } & PollSummary> = [];

  for (const p of parents ?? []) {
    const parent: RealtimeParentRow = {
      id: p.id as string,
      name: p.name as string,
      timezone: p.timezone as string,
      segment_id: (p.segment_id as number | null) ?? null,
      call_delay_minutes: (p.call_delay_minutes as number | null) ?? null,
    };

    let summary: PollSummary;
    try {
      summary = await pollRealtimeParent(supabaseAdmin, parent, now);
    } catch (err) {
      // One broken parent must not stall the others' real-time promise.
      console.error(`[realtime-poll] ${parent.name}: poll threw:`, err);
      results.push({ parentId: parent.id, parentName: parent.name, result: "membership_fetch_failed" });
      continue;
    }
    results.push({ parentId: parent.id, parentName: parent.name, ...summary });

    if (!summary.childId) continue;

    // ── Fallen-behind alarm (spec item 6) ──
    // Only meaningful on a RUNNING child inside its open window — a queue
    // outside calling hours is the normal overnight state, not a fault.
    const { data: child } = await supabaseAdmin
      .from("campaigns_v2")
      .select("id, status, call_windows, timezone")
      .eq("id", summary.childId)
      .single();
    const windows = (child?.call_windows as Array<{ day: string; start: string; end: string }> | null) ?? [];
    if (
      child?.status === "running" &&
      windows.length > 0 &&
      isWithinCallWindow(windows, (child.timezone as string) ?? parent.timezone)
    ) {
      const { data: oldest } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("created_at")
        .eq("campaign_id", summary.childId)
        .eq("outcome", "pending")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (oldest?.created_at) {
        const waitedMin = Math.floor((now.getTime() - new Date(oldest.created_at as string).getTime()) / 60_000);
        if (waitedMin > FALLEN_BEHIND_MINUTES) {
          await alertChildOnceDeduped(
            supabaseAdmin,
            summary.childId,
            "fallen_behind",
            "Realtime: queue has fallen behind",
            [
              `${parent.name}: the oldest waiting player has been queued ${waitedMin} min ` +
                `(threshold ${FALLEN_BEHIND_MINUTES}). One line may no longer be enough — see spec §3.`,
            ],
          );
        }
      }
    }

    // ── Hourly rollup (spec item 5) — minute 0 only ──
    if (now.getMinutes() === 0) {
      const hourAgoIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      const { count: newThisHour } = await supabaseAdmin
        .from("realtime_seen_members")
        .select("cio_id", { count: "exact", head: true })
        .eq("parent_campaign_id", parent.id)
        .eq("status", "queued")
        .gte("first_seen_at", hourAgoIso);
      const { count: calledThisHour } = await supabaseAdmin
        .from("calls_v2")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", summary.childId)
        .gte("created_at", hourAgoIso);
      const { count: waiting } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", summary.childId)
        .in("outcome", ["pending", "pending_retry"]);
      const { count: held } = await supabaseAdmin
        .from("realtime_seen_members")
        .select("cio_id", { count: "exact", head: true })
        .eq("parent_campaign_id", parent.id)
        .eq("status", "waiting");
      await postSlackNote("Realtime hourly", [
        `${parent.name}: +${newThisHour ?? 0} new player(s) this hour, ` +
          `${calledThisHour ?? 0} call(s) made, ${waiting ?? 0} waiting in the queue` +
          `${(held ?? 0) > 0 ? `, ${held} held by the call delay` : ""}.`,
      ]);
    }
  }

  await recordHeartbeat(supabaseAdmin, CRON_NAMES.realtimePoll);
  return NextResponse.json({
    parents: (parents ?? []).length,
    added: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
    results,
  });
}
