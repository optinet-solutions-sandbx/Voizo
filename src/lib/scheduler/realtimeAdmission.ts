// Shared admission core for real-time campaigns (VOZ-180 —
// docs/2026-07-21_SPEC_CustomerIO_Webhook_Ingress.md §6.5).
//
// Both intake lanes — the per-minute poll (realtimePoll.ts) and the
// Customer.io webhook receiver (/api/webhooks/customerio) — route every
// member through THESE two functions, so the no-duplicates rule and the
// compensation logic exist exactly once. The claim upsert on the seen-table
// PK (parent_campaign_id, cio_id) is the single door: whichever lane (or
// overlapping tick, or Customer.io retry) gets there first wins; everyone
// else is a silent duplicate. Only the winner inserts the dial row.
//
// Deploy order: supabase-migration-cio-webhook-ingress.sql adds
// realtime_seen_members.display_name — apply it BEFORE deploying this code.
//
// Relative imports per the house testable-module convention (vitest has no
// "@/" alias in this repo).

import type { SupabaseClient } from "@supabase/supabase-js";
import { endOfDayIsoInTz, startOfDayIsoInTz } from "./recurringSpawn";

export interface TodaysChild {
  id: string;
  name: string;
  daily_cap: number | null;
}

/**
 * Today's child campaign for a realtime parent — the one row both lanes
 * queue into. draft (pre-window) and paused (post-window) children still
 * accept numbers: queued players wait for the window, exactly like the
 * daily flow. `child: null` (with ok) is the normal overnight/off-day state,
 * not an error.
 */
export async function findTodaysChild(
  supabase: SupabaseClient,
  parentId: string,
  timezone: string,
  now: Date,
): Promise<{ ok: boolean; child: TodaysChild | null }> {
  const { data, error } = await supabase
    .from("campaigns_v2")
    .select("id, name, daily_cap")
    .eq("parent_campaign_id", parentId)
    .in("status", ["draft", "running", "paused"])
    .gte("start_at", startOfDayIsoInTz(now, timezone))
    .lt("start_at", endOfDayIsoInTz(now, timezone))
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(`[realtimeAdmission] child query failed for ${parentId}:`, error);
    return { ok: false, child: null };
  }
  return { ok: true, child: (data as TodaysChild | null) ?? null };
}

export type ClaimAndQueueResult =
  | { won: true; queued: boolean }
  | { won: false; reason: "duplicate" | "claim_error" | "insert_failed" };

/**
 * Race-safe claim + (for status 'queued') dial-row insert with compensation.
 *
 * - status 'queued'   → claim bound to childId, then dial row (with name).
 *                       Insert failure releases the claim so the next tick
 *                       retries — a claimed-but-never-queued member would be
 *                       a silently lost player.
 * - status 'waiting'  → claim only (call-delay / off-hours buffer); the
 *                       promotion pass gives them their dial row later.
 * - set-aside statuses ('rejected_country', 'no_phone', 'invalid_phone',
 *                       'lookup_failed') → claim only, permanent for this member.
 */
export async function claimAndQueueMember(
  supabase: SupabaseClient,
  args: {
    parentId: string;
    /** For log lines only. */
    parentName: string;
    cioId: string;
    phone: string | null;
    claimStatus: string;
    /** Today's child — required when claimStatus is 'queued', null otherwise. */
    childId: string | null;
    /** Raw player name (greet-by-name); persisted on claim row AND dial row. */
    displayName: string | null;
  },
): Promise<ClaimAndQueueResult> {
  const queueNow = args.claimStatus === "queued";

  const { data: claimed, error: claimErr } = await supabase
    .from("realtime_seen_members")
    .upsert(
      {
        parent_campaign_id: args.parentId,
        cio_id: args.cioId,
        phone_e164: args.phone,
        status: args.claimStatus,
        child_campaign_id: queueNow ? args.childId : null,
        display_name: args.displayName,
      },
      { onConflict: "parent_campaign_id,cio_id", ignoreDuplicates: true },
    )
    .select("cio_id");
  if (claimErr) {
    console.error(`[realtimeAdmission] ${args.parentName}: claim upsert failed for ${args.cioId}:`, claimErr);
    return { won: false, reason: "claim_error" };
  }
  const won = Array.isArray(claimed) && claimed.length > 0;
  if (!won) return { won: false, reason: "duplicate" };
  if (!queueNow) return { won: true, queued: false };

  const { error: insErr } = await supabase.from("campaign_numbers_v2").insert({
    campaign_id: args.childId,
    phone_e164: args.phone,
    outcome: "pending",
    display_name: args.displayName,
  });
  if (insErr) {
    // Unique (campaign_id, phone_e164) violation = the phone IS already queued
    // in this child (a second cio_id sharing the phone — re-signup). Keep the
    // claim: releasing it would loop claim→violate→release on every retry/tick.
    if (insErr.code === "23505") return { won: true, queued: true };
    // Compensation: release the claim so the next tick retries this member.
    console.error(
      `[realtimeAdmission] ${args.parentName}: dial-row insert failed for ${args.cioId} — releasing claim:`,
      insErr,
    );
    await supabase
      .from("realtime_seen_members")
      .delete()
      .eq("parent_campaign_id", args.parentId)
      .eq("cio_id", args.cioId);
    return { won: false, reason: "insert_failed" };
  }
  return { won: true, queued: true };
}

/**
 * Serve one 'waiting' member their dial row (call-delay / buffered intake).
 * Race-proof flip: only the tick that wins the waiting→queued update inserts
 * the dial row. Insert failure flips back to 'waiting' — first_seen_at is
 * untouched, so the delay clock never resets.
 */
export async function promoteWaitingMember(
  supabase: SupabaseClient,
  args: {
    parentId: string;
    parentName: string;
    cioId: string;
    phone: string;
    displayName: string | null;
    childId: string;
  },
): Promise<"promoted" | "skipped" | "failed"> {
  const { data: flipped, error: flipErr } = await supabase
    .from("realtime_seen_members")
    .update({ status: "queued", child_campaign_id: args.childId })
    .eq("parent_campaign_id", args.parentId)
    .eq("cio_id", args.cioId)
    .eq("status", "waiting")
    .select("cio_id");
  if (flipErr || !flipped || flipped.length === 0) return "skipped";

  const { error: insErr } = await supabase.from("campaign_numbers_v2").insert({
    campaign_id: args.childId,
    phone_e164: args.phone,
    outcome: "pending",
    display_name: args.displayName,
  });
  if (insErr) {
    // Same duplicate-phone rule as claimAndQueueMember: already queued = done.
    if (insErr.code === "23505") return "promoted";
    console.error(
      `[realtimeAdmission] ${args.parentName}: promotion insert failed for ${args.cioId} — flipping back:`,
      insErr,
    );
    await supabase
      .from("realtime_seen_members")
      .update({ status: "waiting", child_campaign_id: null })
      .eq("parent_campaign_id", args.parentId)
      .eq("cio_id", args.cioId);
    return "failed";
  }
  return "promoted";
}
