import { supabaseAdmin } from "./supabaseServer";
import { originateCall } from "./freeswitch/originate";

/**
 * Check if the current time falls within the campaign's call windows.
 * Manifesto §6: "Check call window before every dial. Not once at campaign start — every time."
 */
export function isWithinCallWindow(
  callWindows: Array<{ day: string; start: string; end: string }>,
  timezone: string,
): boolean {
  if (!callWindows || callWindows.length === 0) return true; // no windows = always open

  // Get current time in the campaign's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase().slice(0, 3) || "";
  const hour = parts.find((p) => p.type === "hour")?.value || "00";
  const minute = parts.find((p) => p.type === "minute")?.value || "00";
  const currentTime = `${hour}:${minute}`;

  const todayWindow = callWindows.find((w) => w.day === weekday);
  if (!todayWindow) return false; // no window defined for today

  return currentTime >= todayWindow.start && currentTime < todayWindow.end;
}

/**
 * Returns true when the campaign has work that's not yet terminal:
 *   - pending_retry numbers waiting for their retry window (next_attempt_at > now), OR
 *   - in_progress numbers (call fired but no terminal hangup webhook yet — usually
 *     transient, but if the webhook is lost we should NOT auto-complete; the
 *     campaign-heartbeat cron will surface a stuck call for operator action).
 *
 * Pairs with findNextNumber (which only returns numbers eligible RIGHT NOW).
 * Used by start route, freeswitch chain-next, and scheduler cron to avoid
 * prematurely completing a campaign whose only remaining work is queued retries
 * or an in-flight call.
 *
 * Name kept (rather than renamed to e.g. hasOpenWork) for diff-history clarity;
 * the in_progress branch is a defensive expansion documented inline.
 */
export async function hasPendingRetry(campaignId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // (a) pending_retry numbers waiting for their retry window
  const { count: retryCount } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("outcome", "pending_retry")
    .gt("next_attempt_at", nowIso);
  if ((retryCount ?? 0) > 0) return true;

  // (b) in_progress numbers (defensive against lost terminal webhook)
  const { count: inProgressCount } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("outcome", "in_progress");
  return (inProgressCount ?? 0) > 0;
}

/**
 * Find the next eligible number in a campaign:
 * - outcome = 'pending' or 'pending_retry'
 * - not suppressed
 * - attempt_count < campaign.max_attempts
 * - if pending_retry: next_attempt_at <= now
 *
 * Manifesto §6: suppression checked before every calls.create().
 */
export async function findNextNumber(campaignId: string) {
  const { data: campaign, error: cErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("max_attempts")
    .eq("id", campaignId)
    .single();
  if (cErr || !campaign) return null;

  const now = new Date().toISOString();

  // Eligibility is filtered IN THE QUERY (not after .limit), and due-soonest is ordered
  // first. This fixes a starvation stall: campaign_numbers are batch-loaded with a single
  // shared created_at, so .order("created_at") was a meaningless tie and the arbitrary
  // limit(20) window could be filled entirely by not-yet-due pending_retry rows — making
  // findNextNumber return null even though many 'pending' numbers were due NOW (they sat
  // beyond the window). With the eligibility filter the window holds only dialable rows;
  // nullsFirst puts fresh 'pending' (null next_attempt_at) ahead of due retries.
  // id ascending is the final STABLE tiebreak: created_at is batch-identical, so without it the
  // limit(20) window + pick are non-deterministic. id (uuid PK) makes dial order reproducible and
  // matches campaignRunFlow.deriveRunFlow, so the detail page's "Up next" == the number we dial.
  const { data: numbers, error: nErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("*")
    .eq("campaign_id", campaignId)
    .lt("attempt_count", campaign.max_attempts)
    .or(`outcome.eq.pending,and(outcome.eq.pending_retry,next_attempt_at.lte.${now})`)
    .order("next_attempt_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(20);

  if (nErr || !numbers || numbers.length === 0) return null;

  // Defensive backstop (redundant with the query filter above): never surface a
  // not-yet-due pending_retry to dial, even if the filter were ever malformed.
  const eligible = numbers.find((n) => {
    if (n.outcome === "pending_retry") {
      return n.next_attempt_at && n.next_attempt_at <= now;
    }
    return true;
  });

  if (!eligible) return null;

  // Suppression check (Manifesto §6: before every calls.create, no exceptions)
  //
  // Two tables coexist during V1→V2 transition (architecture doc §3.8):
  //   - suppression_list (V2): used by the Campaign V2 dialer, richer schema
  //   - do_not_call (V1): used by the /do-not-call dashboard page, seeded data
  //
  // Both must be checked. A number in EITHER table is suppressed.
  // Consolidation (migrating V1 rows into V2, deprecating do_not_call) is
  // planned for post-demo. Until then, dual-check is the compliance gate.
  //
  // Performance: both tables have UNIQUE index on their phone column.
  // Two indexed lookups = ~2ms total. Negligible even at 100k calls/day.

  const { data: suppressedV2 } = await supabaseAdmin
    .from("suppression_list")
    .select("id")
    .eq("phone_e164", eligible.phone_e164)
    .limit(1);

  const { data: suppressedV1 } = await supabaseAdmin
    .from("do_not_call")
    .select("id")
    .eq("phone_number", eligible.phone_e164)
    .limit(1);

  const isSuppressed =
    (suppressedV2 && suppressedV2.length > 0) ||
    (suppressedV1 && suppressedV1.length > 0);

  if (isSuppressed) {
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "suppressed" })
      .eq("id", eligible.id);
    return findNextNumber(campaignId); // recurse to next
  }

  return eligible;
}

/**
 * Fire an outbound call for the given campaign number via FreeSWITCH +
 * SquareTalk. Returns the created calls_v2 row.
 *
 * Manifesto §6: state written to DB before calling provider.
 */
export async function fireCall(
  campaignId: string,
  campaignNumber: { id: string; phone_e164: string },
  vapiAssistantId: string,
  baseUrl: string,
  vapiSipUri?: string,
) {
  // Mark number as in_progress
  await supabaseAdmin
    .from("campaign_numbers_v2")
    .update({ outcome: "in_progress" })
    .eq("id", campaignNumber.id);

  // Create calls_v2 row BEFORE contacting the provider (state-before-action)
  const { data: callRow, error: callErr } = await supabaseAdmin
    .from("calls_v2")
    .insert({
      campaign_id: campaignId,
      campaign_number_id: campaignNumber.id,
      provider: "freeswitch",
      status: "initiated",
    })
    .select()
    .single();

  if (callErr || !callRow) throw new Error("Failed to create call record");

  try {
    const callerId = process.env.FREESWITCH_CALLER_ID;
    if (!callerId) {
      throw new Error("FREESWITCH_CALLER_ID not set. Required for outbound dialing.");
    }
    const result = await originateCall({
      to: campaignNumber.phone_e164,
      callerId,
      callId: callRow.id,
      vapiAssistantId,
      vapiSipUri,
      campaignId,
      numberId: campaignNumber.id,
    });
    const providerCallId = result.providerCallId;

    await supabaseAdmin
      .from("calls_v2")
      .update({ provider_call_id: providerCallId })
      .eq("id", callRow.id);
  } catch (err) {
    // Provider failed — handle it the same way voice-status would have, since
    // we never reach voice-status when the provider call itself errors:
    //   - Mark calls_v2 row 'failed' so it stops counting as in-flight.
    //   - Increment attempt_count and apply max_attempts logic. Without this,
    //     a sustained provider outage + the cron resume sweep would loop on
    //     the same number forever (attempt_count never hits max → never goes
    //     terminal → cron keeps re-firing every retry_interval_minutes).
    //   - Use campaign.retry_interval_minutes (default 90) for the cooldown
    //     instead of a hardcoded 5-min value that would burn cycles fast.
    const { data: numRow } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("attempt_count")
      .eq("id", campaignNumber.id)
      .single();
    const newAttemptCount = (numRow?.attempt_count ?? 0) + 1;

    const { data: cfg } = await supabaseAdmin
      .from("campaigns_v2")
      .select("retry_interval_minutes, max_attempts")
      .eq("id", campaignId)
      .single();
    const retryMinutes = cfg?.retry_interval_minutes ?? 90;
    const maxAttempts = cfg?.max_attempts ?? 3;

    await supabaseAdmin
      .from("calls_v2")
      .update({ status: "failed", ended_at: new Date().toISOString() })
      .eq("id", callRow.id);

    if (newAttemptCount >= maxAttempts) {
      // Exhausted via provider failures → terminal `unreached`. Mirrors the
      // voice-status webhook's terminal-outcome logic so retry-loop behavior
      // is identical regardless of whether voice-status fires or not.
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({
          attempt_count: newAttemptCount,
          last_attempted_at: new Date().toISOString(),
          outcome: "unreached",
        })
        .eq("id", campaignNumber.id);
    } else {
      const retryAt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString();
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({
          attempt_count: newAttemptCount,
          last_attempted_at: new Date().toISOString(),
          next_attempt_at: retryAt,
          outcome: "pending_retry",
        })
        .eq("id", campaignNumber.id);
    }
    throw err;
  }

  return callRow;
}
