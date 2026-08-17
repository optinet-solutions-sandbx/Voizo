import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../../../lib/supabaseServer";
import { rejectIfCrossOriginStrict } from "../../../../../../lib/csrf";
import { ghostPortalEnabled, ghostSlotReserve } from "../../../../../../lib/ghost/ghostConfig";
import { getGhostRun, updateGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { scrubGhostPhones } from "../../../../../../lib/ghost/ghostScrub";
import { launchGhostRun } from "../../../../../../lib/ghost/launchGhostRun";
import type { CallWindow } from "../../../../../../lib/campaignV2Shared";

/**
 * POST /api/ghost/runs/[id]/launch — materialize a prepared run into the
 * production pipeline (clone → prod-priority lease → PATCH → campaigns_v2).
 *
 * COMPLIANCE (re-enforced here; the client is never trusted):
 *   • Re-scrub DNC server-side on the submitted phones (live also re-applies
 *     recency). The launched list is the NET — suppressed numbers can't be dialed.
 *   • Live tier requires a call window (rejected 400 otherwise).
 *   • All-suppressed ⇒ 422, nothing launched.
 *   • Already-launched ⇒ 409 (no double-launch / double-billing).
 * COST: real calls + SMS. The clone inherits Voizo's guardrails via createClone;
 * GHOST_SLOT_RESERVE keeps prod SIP headroom.
 */
// Structural guard for client-supplied call windows: a LIVE run's windows reach
// the dialer (createCampaignV2 -> isWithinCallWindow), so a malformed window
// could mean wrong-hours dialing. Reject anything that isn't day(sun–sat)+HH:MM.
const VALID_DAYS = new Set(["sun", "mon", "tue", "wed", "thu", "fri", "sat"]);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// VOZ-364: isWithinCallWindowAt now fails CLOSED on an empty/missing window (a
// second fail-open compliance gate). Test-tier ghost runs used to pass `[]` to
// deliberately exploit the old "empty = always open" default so an operator's
// manual verification call could fire at any hour — that must keep working, but
// it can no longer ride on the gate's default. Explicit all-day window instead.
// end is "24:00", NOT "23:59": the gate's close edge is EXCLUSIVE (`nowMinutes < end`)
// and nowMinutes maxes at 1439 == "23:59", so an end of "23:59" would leave the tier
// CLOSED for 23:59:00–23:59:59 — a silent one-minute dead zone in a window whose whole
// purpose is "fire at any hour". hhmmToMinutes("24:00") = 1440 > 1439 always. This
// value skips callWindowsAreValid's stricter HH:MM regex by design: that check runs
// only for the LIVE tier (see below), never for this test-tier constant.
const ALL_DAY_TEST_WINDOWS: CallWindow[] = [...VALID_DAYS].map((day) => ({
  day: day as CallWindow["day"],
  start: "00:00",
  end: "24:00",
}));
function callWindowsAreValid(windows: CallWindow[]): boolean {
  return windows.every(
    (w) =>
      !!w &&
      VALID_DAYS.has(w.day) &&
      typeof w.start === "string" && HHMM.test(w.start) &&
      typeof w.end === "string" && HHMM.test(w.end),
  );
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;
  if (!ghostPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;

  let body: { phones?: unknown; timezone?: unknown; callWindows?: unknown; smsEnabled?: unknown; smsTemplate?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phones = Array.isArray(body.phones)
    ? body.phones.filter((p): p is string => typeof p === "string")
    : [];
  if (phones.length === 0) {
    return NextResponse.json({ error: "phones (non-empty array) is required" }, { status: 400 });
  }

  const run = await getGhostRun(supabaseAdmin, id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (run.status === "launched" || run.status === "launching") {
    return NextResponse.json({ error: `Run already ${run.status}.` }, { status: 409 });
  }

  // Live tier MUST carry a call window — re-enforced at launch (defense in depth).
  const callWindows: CallWindow[] = Array.isArray(body.callWindows) ? (body.callWindows as CallWindow[]) : [];
  if (run.tier === "live" && callWindows.length === 0) {
    return NextResponse.json(
      { error: "A live run requires at least one call window." },
      { status: 400 },
    );
  }
  if (run.tier === "live" && !callWindowsAreValid(callWindows)) {
    return NextResponse.json(
      { error: "Call windows are malformed — each needs day (sun–sat) + HH:MM start/end." },
      { status: 400 },
    );
  }

  const vapiPrivateKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiPrivateKey) {
    console.error(`[ghost] launch run=${id} ABORTED: VAPI_PRIVATE_KEY is not set`);
    return NextResponse.json({ error: "Server misconfigured: VAPI key unavailable." }, { status: 500 });
  }

  // ── Re-scrub server-side (NEVER trust the client's earlier scrub) ──
  const scrub = await scrubGhostPhones(supabaseAdmin, phones, { applyRecency: run.tier === "live" });
  if (scrub.net.length === 0) {
    return NextResponse.json(
      { error: "Every uploaded number is suppressed (DNC/recency). Nothing to dial.", suppressed: scrub.suppressed },
      { status: 422 },
    );
  }

  // Optimistic audit transition so a mid-launch crash is visible.
  await updateGhostRun(supabaseAdmin, id, {
    status: "launching",
    scrubbed_count: scrub.net.length,
    suppressed_count: scrub.suppressed,
  });

  const result = await launchGhostRun({
    supabase: supabaseAdmin,
    vapiPrivateKey,
    reserve: ghostSlotReserve(),
    run: {
      id: run.id,
      name: run.name,
      tier: run.tier,
      base_assistant_id: run.base_assistant_id,
      operator: run.operator,
    },
    systemPrompt: "", // ghost clones inherit the base assistant's prompt
    timezone: typeof body.timezone === "string" && body.timezone ? body.timezone : "UTC",
    callWindows: run.tier === "test" ? ALL_DAY_TEST_WINDOWS : callWindows,
    numbers: scrub.net,
    smsEnabled: body.smsEnabled === true,
    smsTemplate: typeof body.smsTemplate === "string" ? body.smsTemplate : null,
  });

  if (!result.ok) {
    await updateGhostRun(supabaseAdmin, id, { status: "failed", fail_reason: result.error });
    console.error(`[ghost] launch run=${id} FAILED status=${result.status}: ${result.error}`);
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  await updateGhostRun(supabaseAdmin, id, {
    status: "launched",
    campaign_id: result.campaignId,
    launched_at: new Date().toISOString(),
  });
  console.log(
    `[ghost] launch run=${id} OK campaign=${result.campaignId} slot=${result.slotIndex} dialed=${result.numberCount}`,
  );

  return NextResponse.json({
    ok: true,
    campaignId: result.campaignId,
    slotIndex: result.slotIndex,
    numberCount: result.numberCount,
  });
}
