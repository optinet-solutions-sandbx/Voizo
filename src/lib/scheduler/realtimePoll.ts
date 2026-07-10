// Real-time campaign top-up (VOZ-132 — docs/2026-07-09_SPEC_RealTime_Campaigns_and_Operator_Controls.md).
//
// A real-time campaign is a recurring parent with campaigns_v2.realtime=true.
// Its daily children spawn EMPTY (recurringSpawn.ts realtime branch); this
// module is their only number source: every minute the realtime-poll cron
// diffs Customer.io segment membership against realtime_seen_members and
// admits new members through country + daily-cap checks.
//
// Pure decision logic first (unit-tested in realtimePoll.test.ts);
// I/O orchestration below.

// Relative imports (not "@/lib/..."): vitest has no alias config in this
// repo — tested lib modules must resolve without it. Modules whose import
// chain loads supabaseServer (throws without env) are dynamic-imported
// inside functions for the same reason.
import type { SupabaseClient } from "@supabase/supabase-js";
import { COUNTRY_TO_TIMEZONES, detectCountry } from "../audienceCountry";
import { parsePhoneList } from "../campaignV2Shared";

// ── Pure decisions ────────────────────────────────────────────────────────

/**
 * Inverse of COUNTRY_TO_TIMEZONES. America/Toronto → "NA" (the +1 bucket —
 * a US number in a CA list is undetectable by prefix; known limit, same as
 * the wizard's audience guard). UTC/unknown → null = no country constraint.
 */
export function expectedCountryForTimezone(tz: string): string | null {
  if (tz === "UTC") return null; // the explicit "no constraint" zone
  for (const [country, zones] of Object.entries(COUNTRY_TO_TIMEZONES)) {
    if (zones.includes(tz)) return country;
  }
  return null;
}

export type Admission =
  | { admit: true; phone: string }
  | {
      admit: false;
      claimStatus: "rejected_country" | "no_phone" | "invalid_phone";
      phone: string | null;
    }
  | { admit: false; capBlocked: true };

/**
 * Admission decision for ONE new segment member (spec item 4 — boundary
 * checks at the door). Cap first: a capped day does no phone/country work
 * and claims nothing, so cap-blocked members retry on a later day. Country
 * and phone-shape failures ARE claimed (permanent for this member).
 */
export function decideAdmission(args: {
  rawPhone: string | null;
  expectedCountry: string | null;
  addedToday: number;
  dailyCap: number | null;
}): Admission {
  if (args.dailyCap != null && args.addedToday >= args.dailyCap) {
    return { admit: false, capBlocked: true };
  }
  if (args.rawPhone == null || args.rawPhone.trim() === "") {
    return { admit: false, claimStatus: "no_phone", phone: null };
  }
  const [phone] = parsePhoneList(args.rawPhone);
  if (!phone) return { admit: false, claimStatus: "invalid_phone", phone: null };
  if (args.expectedCountry != null && detectCountry(phone) !== args.expectedCountry) {
    return { admit: false, claimStatus: "rejected_country", phone };
  }
  return { admit: true, phone };
}

/** Unseen member ids, input order, deduped. */
export function diffNewMembers(memberIds: string[], seenIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const id of memberIds) {
    if (seenIds.has(id) || emitted.has(id)) continue;
    emitted.add(id);
    out.push(id);
  }
  return out;
}

// ── Day rollover ──────────────────────────────────────────────────────────

/**
 * Spec §9 "late evening" case: players queued yesterday but never terminal
 * must be dialed today. Carry pending/pending_retry into the new child
 * (attempt_count preserved so max-tries spans days); close the old rows as
 * 'unreached' (truthful for THAT day's reporting — the player continues in
 * today's child).
 */
export function partitionRollover(
  rows: Array<{ id: string; phone_e164: string; attempt_count: number | null; outcome: string }>,
): { carry: Array<{ phone_e164: string; attempt_count: number }>; closeIds: string[] } {
  const open = rows.filter((r) => r.outcome === "pending" || r.outcome === "pending_retry");
  return {
    carry: open.map((r) => ({ phone_e164: r.phone_e164, attempt_count: r.attempt_count ?? 0 })),
    closeIds: open.map((r) => r.id),
  };
}

/**
 * Called by spawnChildIfDue (realtime branch) right after today's child is
 * fully created. Failure-ordering guarantee: old rows are only closed AFTER
 * the carry insert succeeds — a failed carry leaves them open, so the next
 * spawn retries and no player is silently lost.
 */
export async function rolloverLeftovers(
  supabase: SupabaseClient,
  parentId: string,
  newChildId: string,
  dayStartIso: string,
): Promise<{ carried: number }> {
  // Most recent PRIOR child — it may be paused (overnight auto-pause), still
  // draft (never started), or running. 'skipped' children have no numbers.
  const { data: prev, error: prevErr } = await supabase
    .from("campaigns_v2")
    .select("id, name, status, vapi_assistant_id, vapi_pool_slot_id")
    .eq("parent_campaign_id", parentId)
    .neq("id", newChildId)
    .neq("status", "skipped")
    .lt("start_at", dayStartIso)
    .order("start_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prevErr) {
    console.error(`[realtimePoll.rollover] prev-child query failed for ${parentId}:`, prevErr);
    return { carried: 0 };
  }
  if (!prev) return { carried: 0 }; // first-ever day

  const { data: rows, error: rowsErr } = await supabase
    .from("campaign_numbers_v2")
    .select("id, phone_e164, attempt_count, outcome")
    .eq("campaign_id", prev.id as string)
    .in("outcome", ["pending", "pending_retry"]);
  if (rowsErr) {
    console.error(`[realtimePoll.rollover] leftover query failed for ${prev.id}:`, rowsErr);
    return { carried: 0 };
  }

  const { carry, closeIds } = partitionRollover(
    (rows ?? []) as Array<{ id: string; phone_e164: string; attempt_count: number | null; outcome: string }>,
  );
  if (carry.length > 0) {
    const { error: insErr } = await supabase.from("campaign_numbers_v2").insert(
      carry.map((c) => ({
        campaign_id: newChildId,
        phone_e164: c.phone_e164,
        attempt_count: c.attempt_count,
        outcome: "pending",
      })),
    );
    if (insErr) {
      console.error(`[realtimePoll.rollover] carry insert failed (old rows left open):`, insErr);
      return { carried: 0 };
    }
    // Stomp-guard on outcome (matches the sweeper style): a late webhook that
    // flipped a row terminal between our SELECT and now is not overwritten.
    const { error: closeErr } = await supabase
      .from("campaign_numbers_v2")
      .update({ outcome: "unreached" })
      .in("id", closeIds)
      .in("outcome", ["pending", "pending_retry"]);
    if (closeErr) {
      // Carried AND old rows still open → yesterday's child would re-carry
      // on a hypothetical re-spawn, but the per-day idempotency makes that
      // impossible today; loud-log and move on.
      console.error(`[realtimePoll.rollover] close update failed:`, closeErr);
    }
  }

  // Close yesterday's child + release its clone/slot if still held. Without
  // this, a child paused overnight with PAUSE_RELEASES_SLOT=false pins a SIP
  // slot forever → pool exhaustion within days. Pointers are captured above,
  // nulled in the close, then cleaned via the shared helper (scheduler pattern).
  const capturedAssistantId = (prev.vapi_assistant_id as string | null) ?? null;
  const capturedSlotId = (prev.vapi_pool_slot_id as string | null) ?? null;
  const { data: closed, error: closeCampaignErr } = await supabase
    .from("campaigns_v2")
    .update({
      status: "completed",
      vapi_assistant_id: null,
      vapi_pool_slot_id: null,
      vapi_sip_uri: null,
    })
    .eq("id", prev.id as string)
    .in("status", ["draft", "running", "paused"])
    .select("id")
    .maybeSingle();
  if (closeCampaignErr) {
    console.error(`[realtimePoll.rollover] child close failed for ${prev.id}:`, closeCampaignErr);
  }
  if (closed && (capturedAssistantId || capturedSlotId)) {
    // Lazy import: campaignVapiCleanup's chain uses "@/" aliases (test poison).
    const { performCampaignVapiCleanup } = await import("../vapi/campaignVapiCleanup");
    const { vapiWarnings } = await performCampaignVapiCleanup(supabase, {
      vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
      campaignName: (prev.name as string) ?? (prev.id as string),
      vapiAssistantId: capturedAssistantId,
      vapiPoolSlotId: capturedSlotId,
    });
    if (vapiWarnings.length > 0) {
      console.warn(`[realtimePoll.rollover] ${prev.name}: cleanup warnings: ${vapiWarnings.join(" | ")}`);
    }
  }

  if (carry.length > 0) {
    console.log(
      `[realtimePoll.rollover] carried ${carry.length} uncalled player(s) from ${prev.name} into ${newChildId}`,
    );
  }
  return { carried: carry.length };
}
