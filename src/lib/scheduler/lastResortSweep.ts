// Last-resort text sweep (VOZ-132 §8, built 2026-07-10).
//
// Campaigns with sms_last_resort_template set: players who exhausted every
// call attempt (outcome='unreached' AT max_attempts) receive the campaign's
// ONE "sorry we missed you" text. The attempt_count >= max_attempts filter is
// load-bearing: realtime rollover closes yesterday's uncalled rows as
// 'unreached' UNDER max while the player continues in today's child — those
// must never be texted.
//
// Runs at the END of the campaign-scheduler tick behind a wall-clock guard so
// SMS sends can never starve dial budget. The send sequence mirrors the
// end-of-call webhook's proven block (suppression gate → non-failed dedup with
// stale-queued repair → 'queued' insert AS the claim, race-proof via the
// sms-dedup partial unique index → Mobivate send → status update).
// ponytail: sequence is copied from the webhook rather than extracted into a
// shared dispatcher — refactoring the live money path 3 days before go-live
// is worse than one duplicate; extract post-launch.
//
// Dormant: no campaign has the column set today. Pre-migration, the filter on
// the missing column errors → logged, sweep skipped, tick unaffected.

import type { SupabaseClient } from "@supabase/supabase-js";
import { decideLastResortSend, type SmsConsentMode } from "../smsDispatchDecision";
import { getMobivateConfigError, sendSMS } from "../mobivate";

/** Cost + budget bound: sends are not latency-critical (the player already
 *  missed every call today); the remainder goes next tick (60s later). */
const SENDS_PER_TICK = 5;
/** Loud-logged scan bound per campaign (PoC campaigns are ≤ hundreds). */
const CANDIDATE_SCAN_CAP = 1000;
/** Webhook parity: 'queued' rows from a crashed tick stop blocking after this. */
const QUEUED_FRESH_MS = 15 * 60 * 1000;
/** Skip the whole sweep when less than this remains of the tick budget. */
const MIN_BUDGET_MS = 15_000;

export interface LastResortSweepResult {
  sent: number;
  suppressed: number;
  skipped: "low_budget" | "query_failed" | null;
}

export async function runLastResortSweep(
  supabase: SupabaseClient,
  remainingBudgetMs: number,
): Promise<LastResortSweepResult> {
  if (remainingBudgetMs < MIN_BUDGET_MS) {
    return { sent: 0, suppressed: 0, skipped: "low_budget" };
  }

  // select * — deploy-order safe reads; the .not() filter on a pre-migration
  // column errors → sweep skips, tick unaffected.
  const { data: campaigns, error: campErr } = await supabase
    .from("campaigns_v2")
    .select("*")
    .not("sms_last_resort_template", "is", null)
    .in("status", ["running", "paused"]);
  if (campErr) {
    console.warn(
      "[lastResort] campaigns query failed (pre-migration is expected to land here):",
      campErr.message,
    );
    return { sent: 0, suppressed: 0, skipped: "query_failed" };
  }

  let sent = 0;
  let suppressed = 0;

  for (const c of campaigns ?? []) {
    if (sent >= SENDS_PER_TICK) break;

    const template = ((c.sms_last_resort_template as string) ?? "").trim();
    const mode: SmsConsentMode =
      c.sms_consent_mode === "registered_optin" ? "registered_optin" : "verbal_yes";
    // Cheap campaign-level short-circuit; decideLastResortSend re-checks per
    // number (single source of truth for the policy).
    if (!template || c.sms_enabled !== true || mode !== "registered_optin") continue;

    const campaignId = c.id as string;
    const campaignName = (c.name as string) ?? campaignId;
    const maxAttempts = (c.max_attempts as number) ?? 3;

    const { data: nums, error: numsErr } = await supabase
      .from("campaign_numbers_v2")
      .select("id, phone_e164, attempt_count, outcome")
      .eq("campaign_id", campaignId)
      .eq("outcome", "unreached")
      .gte("attempt_count", maxAttempts)
      .limit(CANDIDATE_SCAN_CAP);
    if (numsErr) {
      console.error(`[lastResort] ${campaignName}: candidate query failed:`, numsErr);
      continue;
    }
    if ((nums ?? []).length === CANDIDATE_SCAN_CAP) {
      console.warn(
        `[lastResort] ${campaignName}: candidate scan hit cap ${CANDIDATE_SCAN_CAP} — later rows wait for earlier ones to be texted.`,
      );
    }

    const candidates = (nums ?? []).filter((n) =>
      decideLastResortSend({
        outcome: n.outcome as string,
        attemptCount: (n.attempt_count as number | null) ?? null,
        maxAttempts,
        mode,
        smsEnabled: true,
        lastResortTemplate: template,
        campaignStatus: c.status as string,
      }),
    );
    if (candidates.length === 0) continue;

    // Batch one-text-per-player dedup (smsRetire pattern): statuses of every
    // candidate's SMS rows, chunked .in to stay under PostgREST URL limits.
    const candidateIds = candidates.map((n) => n.id as string);
    const smsRowsByNumber = new Map<string, Array<{ id: string; status: string; created_at: string }>>();
    for (let i = 0; i < candidateIds.length; i += 100) {
      const chunk = candidateIds.slice(i, i + 100);
      const { data: smsRows, error: smsErr } = await supabase
        .from("sms_messages_v2")
        .select("id, campaign_number_id, status, created_at")
        .in("campaign_number_id", chunk);
      if (smsErr) {
        console.error(`[lastResort] ${campaignName}: dedup lookup failed for a chunk (fail-closed):`, smsErr);
        // Fail CLOSED for this chunk: without dedup data we must not send.
        for (const id of chunk) smsRowsByNumber.set(id, [{ id: "unknown", status: "queued", created_at: new Date().toISOString() }]);
        continue;
      }
      for (const s of smsRows ?? []) {
        const id = s.campaign_number_id as string | null;
        if (!id) continue;
        const arr = smsRowsByNumber.get(id) ?? [];
        arr.push({ id: s.id as string, status: (s.status as string) ?? "", created_at: (s.created_at as string) ?? "" });
        smsRowsByNumber.set(id, arr);
      }
    }

    for (const n of candidates) {
      if (sent >= SENDS_PER_TICK) {
        console.log(`[lastResort] ${campaignName}: per-tick send cap reached — rest next tick.`);
        break;
      }
      const numberId = n.id as string;
      const phone = n.phone_e164 as string;

      // One text per player per campaign: any non-failed row blocks — except
      // stale 'queued' rows (crashed tick), repaired to failed first
      // (webhook parity; a stranded queued row must not eat the one text).
      const prior = smsRowsByNumber.get(numberId) ?? [];
      const staleQueued = prior.filter(
        (s) => s.status === "queued" && Date.now() - Date.parse(s.created_at) >= QUEUED_FRESH_MS,
      );
      if (staleQueued.length > 0) {
        await supabase
          .from("sms_messages_v2")
          .update({ status: "failed", error_message: "stale queued — superseded by last-resort sweep" })
          .in("id", staleQueued.map((s) => s.id));
      }
      const blocking = prior.filter(
        (s) => s.status !== "failed" && !staleQueued.some((q) => q.id === s.id),
      );
      if (blocking.length > 0) continue;

      // Suppression gate (Manifesto: checked before every irreversible send).
      const { data: sup } = await supabase
        .from("suppression_list")
        .select("id")
        .eq("phone_e164", phone)
        .limit(1);
      if (sup && sup.length > 0) {
        suppressed++;
        continue;
      }

      // Latest call for observability linkage (an exhausted number always has calls).
      const { data: lastCall } = await supabase
        .from("calls_v2")
        .select("id")
        .eq("campaign_number_id", numberId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      // Claim insert — the sms-dedup partial unique index rejects raced
      // duplicates, so the insert IS the race gate (webhook parity).
      const { data: smsRow, error: insErr } = await supabase
        .from("sms_messages_v2")
        .insert({
          campaign_id: campaignId,
          call_id: (lastCall?.id as string | undefined) ?? null,
          campaign_number_id: numberId,
          to_phone_e164: phone,
          body: template,
          provider: "mobivate",
          status: "queued",
        })
        .select("id")
        .single();
      if (insErr || !smsRow) {
        console.error(`[lastResort] ${campaignName}: claim insert failed — NOT sending:`, insErr);
        continue;
      }

      if (getMobivateConfigError()) {
        console.warn(
          `[lastResort] ${campaignName}: SMS queued for ${phone.slice(0, -4)}**** but Mobivate not configured — row stays 'queued'.`,
        );
        sent++; // counts against the cap: the claim is placed
        continue;
      }

      const result = await sendSMS({ to: phone, body: template, reference: smsRow.id });
      await supabase
        .from("sms_messages_v2")
        .update({
          status: result.success ? "sent" : "failed",
          provider_message_id: result.providerMessageId,
          error_message: result.error,
        })
        .eq("id", smsRow.id);
      console.log(
        `[lastResort] ${campaignName}: last-resort SMS ${result.success ? "sent" : "failed"} → ${phone.slice(0, -4)}**** (reason=exhausted_${maxAttempts}_tries)`,
      );
      sent++;
    }
  }

  return { sent, suppressed, skipped: null };
}
