import { supabaseAdmin } from "./supabaseServer";
import { originateCall } from "./freeswitch/originate";
import { resolveFreeswitchCallerId } from "./freeswitch/callerId";
import { isWithinCallWindowAt } from "./scheduleWindow";

/**
 * Check if the current time falls within the campaign's call windows.
 * Manifesto §6: "Check call window before every dial. Not once at campaign start — every time."
 *
 * DELEGATES to scheduleWindow.isWithinCallWindowAt (VOZ-360/VOZ-365). This function
 * used to carry its own ~20-line copy of the logic, described in scheduleWindow.ts as
 * "a deliberate, documented ~15-line mirror". The two copies then DIVERGED: the V8
 * `hour12:false` "24" midnight normalization was added to the mirror only, and its
 * comment claimed the omission "never affects a dial decision" — but THIS function is
 * the one that decides dials, so the dialer was the copy missing the fix. Both copies
 * also shared the `.find()` single-window bug and the lexical time compare.
 *
 * One implementation now, so the wizard's "open now?" preview can never disagree with
 * what actually dials.
 *
 * ⚠️ scheduleWindow.ts must stay pure and dependency-free — it is imported by client
 * components (StepSchedule/wizardState) AND by this server-only module. A client-only
 * dependency added there would break the dial path at build time.
 */
export function isWithinCallWindow(
  callWindows: Array<{ day: string; start: string; end: string }>,
  timezone: string,
): boolean {
  return isWithinCallWindowAt(callWindows, timezone, Date.now());
}

/**
 * Hard per-number-row dial ceiling (2026-08-05, companion to the no-burn rule).
 *
 * Transient trunk failures no longer consume the player's attempt budget — so
 * something else must bound the loop when a number fails forever. Every dial
 * inserts a calls_v2 row BEFORE contacting the provider (fireCall,
 * state-before-action), so counting those rows bounds every path: webhook
 * retries AND provider-error retries. Realtime rollover gives each player a
 * fresh row per day, so this is effectively a per-day cap.
 *
 * 9 = 3 legit ring-attempts + headroom for a full day of ~90-min transient
 * retry cycles. The reject breaker (VOZ-278) still pauses a campaign-wide
 * blockage within minutes; this is the per-number backstop beneath it.
 */
export const TOTAL_DIAL_CEILING = 9;

export async function exceededDialCeiling(campaignNumberId: string): Promise<boolean> {
  const { count, error } = await supabaseAdmin
    .from("calls_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_number_id", campaignNumberId);
  if (error) {
    // Fail-open: a broken count must not halt dialing (max_attempts still
    // bounds delivered calls; the breaker bounds systemic failure).
    console.error(`[dialer.ceiling] count failed for ${campaignNumberId} (treating as under ceiling):`, error.message);
    return false;
  }
  return (count ?? 0) >= TOTAL_DIAL_CEILING;
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
 *
 * FAILS SAFE toward "true" (VOZ-365). Both counts previously destructured only
 * `count`, so a transient Supabase error left it undefined, `(undefined ?? 0) > 0`
 * evaluated false, and the function reported "no work left" on bad data.
 *
 * "true" is the safe answer because every one of the four call sites uses this to
 * decide whether to COMPLETE a campaign, and true always means "stay running":
 *   - campaign-scheduler:569  `if (!hasPendingRetry(...))` → completes + releases the SIP slot
 *   - campaign-scheduler:860  `if (hasPendingRetry(...)) continue` → else completes
 *   - start/route:141         `if (hasPendingRetry(...)) return waiting` → else completes
 *   - voice-status:383        `if (hasPendingRetry(...)) return idle` → else completes
 * Completing wrongly is destructive and asymmetric: it strands every queued retry
 * until the next spawn, and at three of those sites (when PAUSE_RELEASES_SLOT is on)
 * it also clears the Vapi assistant/SIP pointers and releases the pool slot, so
 * recovery needs a re-lease and re-clone. Staying `running` costs one more cron
 * tick, which then re-checks. So on error we report open work and log loudly.
 */
export async function hasPendingRetry(campaignId: string): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // (a) pending_retry numbers waiting for their retry window
  const { count: retryCount, error: retryErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("outcome", "pending_retry")
    .gt("next_attempt_at", nowIso);
  if (retryErr) {
    // FAIL SAFE (VOZ-365): a query error used to leave `count` undefined, and
    // `(undefined ?? 0) > 0` is false — so a transient DB blip read as "no work
    // left" and every caller completed the campaign. See the doc comment above
    // for why "true" is the safe answer at all four call sites.
    console.error(
      `[dialer.hasPendingRetry] pending_retry count failed for campaign ${campaignId} — ` +
        `reporting OPEN WORK so the campaign is not completed on bad data:`,
      retryErr.message,
    );
    return true;
  }
  if ((retryCount ?? 0) > 0) return true;

  // (b) in_progress numbers (defensive against lost terminal webhook)
  const { count: inProgressCount, error: inProgressErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("outcome", "in_progress");
  if (inProgressErr) {
    console.error(
      `[dialer.hasPendingRetry] in_progress count failed for campaign ${campaignId} — ` +
        `reporting OPEN WORK so the campaign is not completed on bad data:`,
      inProgressErr.message,
    );
    return true;
  }
  return (inProgressCount ?? 0) > 0;
}

/** Candidate window per fetch. Doubles as the .in() batch size for the suppression
 *  lookups — 20 is far below the ~200 chunk ceiling undici's header cap imposes. */
const SUPPRESSION_WINDOW_SIZE = 20;
/** Bounds the fully-suppressed-window scan at 20 x 500 = 10,000 numbers. The recursion
 *  this replaced was unbounded, and spun forever if the "mark suppressed" write failed. */
const MAX_SUPPRESSION_WINDOWS = 500;
/** How long to defer a number whose suppression status could not be verified (VOZ-364). */
const DEFER_UNVERIFIABLE_MS = 60_000;

/**
 * FAIL CLOSED (VOZ-364). We could not prove this number is absent from the DNC
 * lists, so we must not dial it. The old code destructured only `data`, so a
 * transient DB error produced `null`, read as "not suppressed", and the dial
 * proceeded — a database blip became a call to a do-not-call number.
 *
 * We deliberately do NOT simply `return null`. Every caller treats null as
 * "nothing to dial", and `hasPendingRetry` counts only pending_retry/in_progress
 * rows — NOT plain 'pending'. So a bare null on a campaign whose remaining numbers
 * are all 'pending' would mark it COMPLETED and, with PAUSE_RELEASES_SLOT on, also
 * release its SIP slot and clear its Vapi pointers. Deferring keeps the campaign
 * alive, retries a minute later, and burns no attempt (VOZ-321 no-burn semantics).
 */
async function deferUnverifiableSuppression(
  row: { id: string },
  reason: string,
): Promise<null> {
  console.error(
    `[dialer.findNextNumber] suppression lookup UNVERIFIABLE for number ${row.id} — ` +
      `refusing to dial, deferring ${DEFER_UNVERIFIABLE_MS / 1000}s:`,
    reason,
  );
  const { error } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .update({
      outcome: "pending_retry",
      next_attempt_at: new Date(Date.now() + DEFER_UNVERIFIABLE_MS).toISOString(),
    })
    .eq("id", row.id);
  if (error) {
    console.error(
      `[dialer.findNextNumber] defer write ALSO failed for ${row.id} — the campaign can ` +
        `still be wrongly completed if nothing else is queued:`,
      error.message,
    );
  }
  return null;
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

  // VOZ-365 #2: this was `return findNextNumber(campaignId)` once per suppressed
  // number — every level added a stack frame AND re-ran four queries, so a segment
  // overlapping the suppression list cost 4N queries and, at a few thousand, blew the
  // stack. Now a BOUNDED loop, with both suppression lookups batched across the whole
  // window via .in(), so skipping N suppressed numbers costs a constant query count.
  // The loop only re-fetches when an ENTIRE window was suppressed, which preserves the
  // old behaviour of continuing past the first 20.
  for (let pass = 0; pass < MAX_SUPPRESSION_WINDOWS; pass++) {
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
      .limit(SUPPRESSION_WINDOW_SIZE);

    if (nErr || !numbers || numbers.length === 0) return null;

    // Defensive backstop (redundant with the query filter above): never surface a
    // not-yet-due pending_retry to dial, even if the filter were ever malformed.
    // Order is preserved, so candidates[0] is still exactly what the old code dialled.
    const candidates = numbers.filter((n) =>
      n.outcome === "pending_retry" ? Boolean(n.next_attempt_at && n.next_attempt_at <= now) : true,
    );

    if (candidates.length === 0) return null;

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
    // Both have a UNIQUE index on their phone column. They were two sequential
    // awaits per candidate; they are independent, so they now run concurrently
    // and cover the whole window in one round trip each.
    const phones = [...new Set(candidates.map((c) => c.phone_e164))];
    const [supV2, supV1] = await Promise.all([
      supabaseAdmin.from("suppression_list").select("phone_e164").in("phone_e164", phones),
      supabaseAdmin.from("do_not_call").select("phone_number").in("phone_number", phones),
    ]);

    // FAIL CLOSED (VOZ-364): unverifiable is treated as suppressed, never as clean.
    if (supV2.error || supV1.error) {
      return deferUnverifiableSuppression(
        candidates[0],
        (supV2.error ?? supV1.error)?.message ?? "unknown suppression lookup error",
      );
    }

    const blocked = new Set<string>([
      ...(supV2.data ?? []).map((r) => r.phone_e164),
      ...(supV1.data ?? []).map((r) => r.phone_number),
    ]);

    const firstClean = candidates.findIndex((c) => !blocked.has(c.phone_e164));
    // Mark exactly the numbers the old code would have marked as it walked past them:
    // everything ahead of the first clean candidate (or the whole window if none is).
    const toSuppress = firstClean === -1 ? candidates : candidates.slice(0, firstClean);

    if (toSuppress.length > 0) {
      const { error: markErr } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({ outcome: "suppressed" })
        .in(
          "id",
          toSuppress.map((c) => c.id),
        );
      if (markErr) {
        console.error(
          `[dialer.findNextNumber] could not mark ${toSuppress.length} number(s) suppressed ` +
            `for campaign ${campaignId}:`,
          markErr.message,
        );
        // Marking is bookkeeping — a number we positively verified as clean is still
        // safe to dial, so don't stall the campaign over a failed write.
        if (firstClean !== -1) return candidates[firstClean];
        // Nothing clean AND the suppressions didn't record: re-fetching would return
        // the identical window forever (the old recursion did exactly that). Defer.
        return deferUnverifiableSuppression(
          candidates[0],
          `could not record suppression: ${markErr.message}`,
        );
      }
    }

    if (firstClean !== -1) return candidates[firstClean];
    // Whole window suppressed AND recorded → loop to fetch the next window.
  }

  console.error(
    `[dialer.findNextNumber] campaign ${campaignId}: stopped after ${MAX_SUPPRESSION_WINDOWS} ` +
      `consecutive fully-suppressed windows (${MAX_SUPPRESSION_WINDOWS * SUPPRESSION_WINDOW_SIZE} numbers).`,
  );
  return null;
}

/**
 * Fire an outbound call for the given campaign number via FreeSWITCH +
 * SquareTalk. Returns the created calls_v2 row, or NULL when another
 * concurrent invocation already claimed this number (caller must treat
 * null as "not fired — skip, no retry bookkeeping").
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
  // Atomic in_progress claim (VOZ-278). This was a blind UPDATE with no
  // outcome guard and no row-count check, so N concurrent callers (cron tick,
  // chain-next, start route) could each "claim" the same pending number and
  // ALL dial it — at sub-second reject cycles that stampeded to 12 dials on
  // one number in 786ms (08-03, 31k calls). The filtered UPDATE + RETURNING
  // makes exactly ONE caller win; losers get 0 rows and back off. Mirrors the
  // voice-status webhook's idempotency claim (route.ts ~L118) and the ESL
  // ghost claim in this file's catch below.
  const { data: claimedNumber } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .update({ outcome: "in_progress" })
    .eq("id", campaignNumber.id)
    .in("outcome", ["pending", "pending_retry"])
    .select("id");

  if (!claimedNumber || claimedNumber.length === 0) {
    console.warn(
      `[dialer.fireCall] number ${campaignNumber.id} already claimed by a concurrent ` +
        `dialer (campaign ${campaignId}) — skipping dial (VOZ-278 stampede guard).`,
    );
    return null;
  }

  // P0.2 (VOZ-357): resolve the ANI BEFORE the insert, so caller_id_e164 lands on
  // the row even when the originate FAILS — which is the case we most need it for.
  // On 2026-08-12, 2,027 dials failed and not one recorded which number it would
  // have presented; establishing per-ANI history for the 08-10 outage needed SSH
  // and a 413 MB CDR file. SquareTalk's own rule is per-caller-ID volume, so we
  // cannot enforce a rule whose variable we never store.
  //
  // resolveFreeswitchCallerId THROWS when nothing is configured. That throw must
  // still happen INSIDE the try below and nowhere else: the number is already
  // claimed 'in_progress' above, and only the catch schedules its retry — throwing
  // here would strand the player in_progress forever. So swallow here and let the
  // authoritative call re-throw.
  let plannedCallerId: string | null = null;
  try {
    plannedCallerId = resolveFreeswitchCallerId(campaignNumber.phone_e164);
  } catch {
    // Deliberately ignored — re-thrown below, where the failure path owns it.
  }

  // Create calls_v2 row BEFORE contacting the provider (state-before-action)
  const { data: callRow, error: callErr } = await supabaseAdmin
    .from("calls_v2")
    .insert({
      campaign_id: campaignId,
      campaign_number_id: campaignNumber.id,
      provider: "freeswitch",
      status: "initiated",
      caller_id_e164: plannedCallerId,
    })
    .select()
    .single();

  if (callErr || !callRow) throw new Error("Failed to create call record");

  try {
    // Per-country owned DID (CA/AU/NZ) with FREESWITCH_CALLER_ID as fallback;
    // throws when nothing is configured (same loud failure as before).
    // Reuse the value resolved above; re-throws here (and only here) if it failed.
    const callerId = plannedCallerId ?? resolveFreeswitchCallerId(campaignNumber.phone_e164);
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
    //   - Schedule a retry WITHOUT burning an attempt (2026-08-05): a provider
    //     failure rang nobody, and max_attempts measures chances the PLAYER
    //     had. The loop is bounded by TOTAL_DIAL_CEILING (every dial inserts a
    //     calls_v2 row first, so the count covers this path too) — not by
    //     silently spending the player's budget on calls they never heard.
    //   - Use campaign.retry_interval_minutes (default 90) for the cooldown
    //     instead of a hardcoded 5-min value that would burn cycles fast.
    //
    // VOZ-269: an ESL-timeout makes originate THROW while FreeSWITCH still placed
    // the call — so this catch must not blindly overwrite a row the hangup webhook
    // may have ALREADY terminalized. Claim 'failed' ONLY while the row is still
    // non-terminal (mirrors voice-status's atomic idempotency claim). If the webhook
    // won the race (the call really connected), the claim matches 0 rows: leave the
    // row and the number exactly as the webhook resolved them, and do NOT queue a
    // retry — that is the double-dial we are killing (35/55).
    // hangup_cause is deliberately left NULL so the webhook's ghost-recovery
    // (VOZ-248) can still self-identify this row if it arrives afterwards; the
    // webhook then counts the attempt iff the call was actually delivered.
    const { data: claimedFail } = await supabaseAdmin
      .from("calls_v2")
      .update({ status: "failed", ended_at: new Date().toISOString() })
      .eq("id", callRow.id)
      .in("status", ["initiated", "ringing", "in_progress", "answered"])
      .select("id");

    if (claimedFail && claimedFail.length > 0) {
      if (await exceededDialCeiling(campaignNumber.id)) {
        console.warn(
          `[dialer.fireCall] number ${campaignNumber.id} hit the ${TOTAL_DIAL_CEILING}-dial ` +
            `ceiling via provider failures — marking unreached (no more retries today).`,
        );
        await supabaseAdmin
          .from("campaign_numbers_v2")
          .update({
            last_attempted_at: new Date().toISOString(),
            outcome: "unreached",
          })
          .eq("id", campaignNumber.id);
      } else {
        const { data: cfg } = await supabaseAdmin
          .from("campaigns_v2")
          .select("retry_interval_minutes")
          .eq("id", campaignId)
          .single();
        const retryMinutes = cfg?.retry_interval_minutes ?? 90;
        const retryAt = new Date(Date.now() + retryMinutes * 60 * 1000).toISOString();
        await supabaseAdmin
          .from("campaign_numbers_v2")
          .update({
            last_attempted_at: new Date().toISOString(),
            next_attempt_at: retryAt,
            outcome: "pending_retry",
          })
          .eq("id", campaignNumber.id);
      }
    } else {
      // The hangup webhook already terminalized this row: the originate "failure"
      // was an ESL-reply timeout on a call that actually connected. The webhook
      // owns the outcome; touching attempt_count or next_attempt_at here would
      // re-queue an already-reached player (VOZ-269).
      console.warn(
        `[dialer.fireCall] originate reported failure for call ${callRow.id} but the ` +
        `row was already terminal — the call was placed (VOZ-269 ghost). Leaving the ` +
        `webhook-set outcome; not burning an attempt or scheduling a retry.`,
      );
    }
    throw err;
  }

  return callRow;
}
