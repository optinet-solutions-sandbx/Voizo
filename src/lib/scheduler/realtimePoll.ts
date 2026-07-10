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
import {
  chunkedPromiseAll,
  extractPhoneFromAttrs,
  getSegmentMembers,
  lookupMemberProfileWithFallback,
  type CustomerIOSegmentMember,
} from "../customerio";
import { fetchAllRows } from "../supabaseFetchAll";
import { postSlackAlert, shouldAlertSpawnFail } from "../alerts/slack";
import { endOfDayIsoInTz, startOfDayIsoInTz } from "./recurringSpawn";

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

  // Never complete/clean a child that still has a LIVE call (pathological
  // late-window + early-spawn overlap): deleting its clone would drop the
  // call mid-conversation. The carry above already happened; the close simply
  // waits — heartbeat reconciliation surfaces a child that stays stuck.
  const { count: inFlight } = await supabase
    .from("calls_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", prev.id as string)
    .in("status", ["initiated", "ringing", "in_progress", "answered"]);
  if ((inFlight ?? 0) > 0) {
    console.warn(
      `[realtimePoll.rollover] ${prev.name}: ${inFlight} live call(s) — skipping child close this spawn.`,
    );
    return { carried: carry.length };
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

// ── Per-minute poll orchestration ─────────────────────────────────────────

/** Profile lookups are the expensive Cio call (up to 3 req each at 10 req/s
 *  acct-wide). Bound the per-tick burst; the remainder stays "new" and is
 *  picked up next tick. ~10-15s per 100 at the 8-chunk/150ms throttle. */
const LOOKUP_CAP_PER_TICK = 100;
/** Matches fetchSegmentPhones' page cap: 10 pages × 1000 members. */
const MEMBERSHIP_PAGE_CAP = 10;
/** Alert dedup window (mirrors recurring spawn_failed's 6h default). */
const ALERT_KIND_DAILY_CAP = "daily_cap";

export interface RealtimeParentRow {
  id: string;
  name: string;
  timezone: string;
  segment_id: number | null;
}

export interface PollSummary {
  result: "no_segment" | "no_child_today" | "membership_fetch_failed" | "polled";
  childId?: string;
  added?: number;
  rejectedCountry?: number;
  capBlocked?: boolean;
  lookupFailed?: number;
  truncated?: number;
}

/**
 * One poll tick for one realtime parent (spec §5): membership diff → profile
 * lookup (new members only) → admission (country + cap) → race-safe claim →
 * dial-row insert into today's child. The claim upsert on the seen-table PK
 * is the no-duplicates rule (spec item 3): overlapping ticks both try, one
 * INSERT wins, only the winner inserts the dial row.
 */
export async function pollRealtimeParent(
  supabase: SupabaseClient,
  parent: RealtimeParentRow,
  now: Date,
): Promise<PollSummary> {
  if (parent.segment_id == null) return { result: "no_segment" };

  // 1) Today's child — same day-math as the spawn idempotency check. draft
  //    (pre-window) and paused (post-window) children still accept numbers:
  //    queued players wait for the window, exactly like the daily flow.
  const dayStart = startOfDayIsoInTz(now, parent.timezone);
  const dayEnd = endOfDayIsoInTz(now, parent.timezone);
  const { data: child, error: childErr } = await supabase
    .from("campaigns_v2")
    .select("id, name, daily_cap")
    .eq("parent_campaign_id", parent.id)
    .in("status", ["draft", "running", "paused"])
    .gte("start_at", dayStart)
    .lt("start_at", dayEnd)
    .limit(1)
    .maybeSingle();
  if (childErr) {
    console.error(`[realtimePoll] ${parent.name}: child query failed:`, childErr);
    return { result: "no_child_today" };
  }
  if (!child) return { result: "no_child_today" }; // spawn cron owns child creation

  const childId = child.id as string;
  const dailyCap = (child.daily_cap as number | null) ?? null;

  // 2) Membership ids — cheap (1 request per 1000 members). Transient fetch
  //    failure → skip this minute, next tick retries (spec §4: "skip a minute
  //    and try again").
  const members = new Map<string, CustomerIOSegmentMember>();
  let cursor: string | undefined;
  for (let pages = 0; pages < MEMBERSHIP_PAGE_CAP; pages++) {
    const batch = await getSegmentMembers(parent.segment_id, { start: cursor, limit: 1000 });
    if (!batch.success) {
      console.warn(`[realtimePoll] ${parent.name}: membership fetch failed: ${batch.error}`);
      return { result: "membership_fetch_failed" };
    }
    for (const m of batch.data.identifiers) {
      if (m.cio_id) members.set(m.cio_id, m);
    }
    if (!batch.data.next) break;
    cursor = batch.data.next;
  }

  // 3) Diff against the seen-table (already-called memory, spec item 1).
  // ponytail: full seen-table scan per tick — fine for months at PoC volume;
  // filter by first_seen_at >= the segment-retention window when it grows.
  const seenRows = await fetchAllRows(supabase, "realtime_seen_members", "cio_id", "cio_id", {
    column: "parent_campaign_id",
    value: parent.id,
  });
  const fresh = diffNewMembers(
    Array.from(members.keys()),
    new Set(seenRows.map((r) => r.cio_id as string)),
  );
  if (fresh.length === 0) return { result: "polled", childId, added: 0 };

  // 4) Cap pre-check BEFORE spending profile lookups. addedToday counts every
  //    row in today's child, including rollover carries — the cap is a
  //    day-cost brake and carried players cost dials today too.
  const { count: addedToday, error: countErr } = await supabase
    .from("campaign_numbers_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", childId);
  if (countErr) {
    console.error(`[realtimePoll] ${parent.name}: addedToday count failed:`, countErr);
    return { result: "polled", childId, added: 0 };
  }
  if (dailyCap != null && (addedToday ?? 0) >= dailyCap) {
    await alertCapOnce(supabase, childId, parent.name, dailyCap);
    return { result: "polled", childId, added: 0, capBlocked: true };
  }

  // 5) Profile lookups for NEW members only, bounded per tick. No silent
  //    caps: log what was deferred.
  const batchIds = fresh.slice(0, LOOKUP_CAP_PER_TICK);
  const truncated = fresh.length - batchIds.length;
  if (truncated > 0) {
    console.log(
      `[realtimePoll] ${parent.name}: ${truncated} new member(s) deferred to next tick (lookup cap ${LOOKUP_CAP_PER_TICK})`,
    );
  }
  const profiles = await chunkedPromiseAll(batchIds, 8, async (cioId) => ({
    cioId,
    lookup: await lookupMemberProfileWithFallback(members.get(cioId)!),
  }));

  // 6) Admit → claim → insert, sequentially (the cap counter is shared state).
  const expectedCountry = expectedCountryForTimezone(parent.timezone);
  let admitted = 0;
  let rejectedCountry = 0;
  let lookupFailed = 0;
  let capBlocked = false;
  const rejectedPhones: string[] = [];

  for (const { cioId, lookup } of profiles) {
    let claimStatus: string;
    let phone: string | null = null;
    let admitThis = false;

    if (!lookup.success) {
      lookupFailed++;
      // Permanent 404 (profile genuinely missing on ALL identifiers — the
      // Glenda class) is claimed so we stop paying for it every minute. ANY
      // other failure (429 rate-limit, 5xx, network) is transient: leave the
      // member UNCLAIMED so the next tick retries — a permanent claim on a
      // transient burst would silently drop a real registrant forever
      // (review finding 2026-07-10).
      if (!/Customer\.io 404/.test(lookup.error)) continue;
      claimStatus = "lookup_failed";
    } else {
      const decision = decideAdmission({
        rawPhone: extractPhoneFromAttrs(lookup.data.attributes),
        expectedCountry,
        addedToday: (addedToday ?? 0) + admitted,
        dailyCap,
      });
      if ("capBlocked" in decision) {
        capBlocked = true;
        break; // stop adding — nothing claimed, members retry on a later day
      }
      if (decision.admit) {
        claimStatus = "queued";
        phone = decision.phone;
        admitThis = true;
      } else {
        claimStatus = decision.claimStatus;
        phone = decision.phone;
        if (claimStatus === "rejected_country" && phone) {
          rejectedCountry++;
          rejectedPhones.push(`${phone.slice(0, -4)}****`);
        }
      }
    }

    // Race-safe claim: PK (parent, cio_id) + ignoreDuplicates. RETURNING is
    // empty when another tick already claimed — then we must NOT insert.
    const { data: claimed, error: claimErr } = await supabase
      .from("realtime_seen_members")
      .upsert(
        {
          parent_campaign_id: parent.id,
          cio_id: cioId,
          phone_e164: phone,
          status: claimStatus,
          child_campaign_id: admitThis ? childId : null,
        },
        { onConflict: "parent_campaign_id,cio_id", ignoreDuplicates: true },
      )
      .select("cio_id");
    if (claimErr) {
      console.error(`[realtimePoll] ${parent.name}: claim upsert failed for ${cioId}:`, claimErr);
      continue; // not claimed → retried next tick
    }
    const won = Array.isArray(claimed) && claimed.length > 0;
    if (!won || !admitThis) continue;

    const { error: insErr } = await supabase.from("campaign_numbers_v2").insert({
      campaign_id: childId,
      phone_e164: phone,
      outcome: "pending",
    });
    if (insErr) {
      // Compensation: a claimed-but-never-queued member would be a silently
      // lost player. Release the claim so the next tick retries.
      console.error(`[realtimePoll] ${parent.name}: dial-row insert failed for ${cioId} — releasing claim:`, insErr);
      await supabase
        .from("realtime_seen_members")
        .delete()
        .eq("parent_campaign_id", parent.id)
        .eq("cio_id", cioId);
      continue;
    }
    admitted++;
  }

  // 7) Operator flags (spec item 4). Wrong-country posts at most once per
  //    member by construction (each member is claimed exactly once).
  if (rejectedPhones.length > 0) {
    await postSlackAlert("WARN", "Realtime: wrong-country numbers set aside", [
      `${parent.name}: ${rejectedPhones.length} number(s) didn't match the campaign country — never dialed.`,
      ...rejectedPhones.slice(0, 8),
    ]);
  }
  if (capBlocked) {
    await alertCapOnce(supabase, childId, parent.name, dailyCap ?? 0);
  }
  if (admitted > 0) {
    console.log(`[realtimePoll] ${parent.name}: +${admitted} player(s) queued into ${child.name}`);
  }

  return { result: "polled", childId, added: admitted, rejectedCountry, capBlocked, lookupFailed, truncated };
}

/**
 * Post a per-child Slack WARN at most once per ~6h per kind (a per-tick
 * condition like cap-full or fallen-behind fires every minute otherwise).
 * Shared by the poll (daily_cap) and the cron route (fallen_behind).
 */
export async function alertChildOnceDeduped(
  supabase: SupabaseClient,
  childId: string,
  kind: string,
  title: string,
  details: string[],
): Promise<void> {
  const { data: state } = await supabase
    .from("realtime_alert_state")
    .select("last_alerted_at")
    .eq("child_campaign_id", childId)
    .eq("kind", kind)
    .maybeSingle();
  if (!shouldAlertSpawnFail((state?.last_alerted_at as string | null) ?? null, Date.now())) return;
  await postSlackAlert("WARN", title, details);
  await supabase.from("realtime_alert_state").upsert(
    { child_campaign_id: childId, kind, last_alerted_at: new Date().toISOString() },
    { onConflict: "child_campaign_id,kind" },
  );
}

/** Daily-cap WARN, deduped. */
async function alertCapOnce(
  supabase: SupabaseClient,
  childId: string,
  parentName: string,
  cap: number,
): Promise<void> {
  await alertChildOnceDeduped(supabase, childId, ALERT_KIND_DAILY_CAP, "Realtime: daily cap reached", [
    `${parentName}: today's cap (${cap}) is full — new signups wait for tomorrow's campaign.`,
  ]);
}
