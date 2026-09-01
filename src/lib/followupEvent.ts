// Email follow-up dispatch (2026-09-01 plan) — fires ONE `voizo_call_followup` event at
// Customer.io when a call's SMS follow-up goes out; a CIO event-triggered campaign sends the
// actual email. Voizo never sends player email.
//
// Called from inside the end-of-call webhook's SMS dispatch block, AFTER every gate the SMS
// already passed (consent decision, suppression_list, SMS dedup, the risk-disclosure veto via
// optedOut) — so this module adds no gate logic of its own. What it adds is the OUTBOUND
// discipline, each rule an answer to "when does this fail?":
//
//   LEDGER BEFORE PROVIDER  a cio_track_events row is written 'queued' before the Track call
//                           (sms_messages_v2 §6 pattern). A crash between the two leaves a
//                           visible queued row — never a silent double-send.
//   THE DOOR                uniq_followup_per_contact (partial unique index, status <> 'failed')
//                           makes the DB refuse a second follow-up per contact — a concurrent
//                           webhook retry cannot race past it (TOCTOU-proof, like the SMS rule).
//   FAIL CLOSED             no Track key → dormant (deploy-safe before the Vercel env lands);
//                           no identity → no event; a broken supabase client → {fired:false}.
//   NEVER THROWS            a follow-up email must never be able to break live call handling.
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { resolveTrackCredential, sendTrackEvent } from "./cioTrack";
import { CIO_DEFAULT_WORKSPACE } from "./customerio";

export const VOIZO_CALL_FOLLOWUP = "voizo_call_followup";

export interface FollowupArgs {
  /** campaigns_v2.cio_workspace — null/undefined = the default brand, same rule as SMS sender. */
  workspace: string | null | undefined;
  campaignId: string | null;
  campaignNumberId: string;
  callId: string | null;
  /** E.164, for the identity ladder's seen-members rung. */
  phone: string;
  /** campaign_numbers_v2.cio_id — rung 1 of the ladder. */
  rowCioId: string | null;
  /** The dashboard's attempt tag for this call (positive/neutral/…) — CIO segments on it. */
  callOutcome: string;
  smsSent: boolean;
}

export type FollowupResult = {
  fired: boolean;
  reason: "sent" | "no_track_key" | "no_identity" | "duplicate" | "ledger_error" | "send_failed";
};

/** Postgres unique violation — the door saying "this follow-up already exists". */
const PG_UNIQUE_VIOLATION = "23505";

export async function fireCallFollowup(supabase: SupabaseClient, args: FollowupArgs): Promise<FollowupResult> {
  try {
    const workspace = args.workspace || CIO_DEFAULT_WORKSPACE;

    // ── credential: fail closed, checked FIRST so a missing env writes nothing anywhere ──
    const credential = resolveTrackCredential(process.env.CUSTOMERIO_TRACK_API_KEYS, workspace);
    if (!credential) {
      console.log(`[followup] no Track key for workspace=${workspace} — channel dormant, nothing sent`);
      return { fired: false, reason: "no_track_key" };
    }

    // ── identity ladder: row.cio_id → realtime_seen_members by phone (most recent claim) ──
    // ponytail: the plan's third rung (App-API phone lookup) is deferred — the live lanes are all
    // realtime/recurring, which rungs 1+2 fully cover; add the API rung only if 'no_identity'
    // shows up in numbers on real traffic.
    let cioId = args.rowCioId;
    if (!cioId) {
      const { data } = await supabase
        .from("realtime_seen_members")
        .select("cio_id")
        .eq("phone_e164", args.phone)
        .not("cio_id", "is", null)
        .order("first_seen_at", { ascending: false })
        .limit(1);
      cioId = (Array.isArray(data) && data[0]?.cio_id) || null;
      if (cioId) {
        // Self-healing write-back, best-effort: next dispatch for this row skips the lookup.
        await supabase.from("campaign_numbers_v2").update({ cio_id: cioId }).eq("id", args.campaignNumberId);
      }
    }
    if (!cioId) {
      console.log(`[followup] no CIO identity for ${args.phone.slice(0, -4)}**** — no event (wizard-pasted or pre-identity row)`);
      return { fired: false, reason: "no_identity" };
    }

    // ── ledger row, BEFORE the provider call. Client-minted id: the later status update must
    //    not depend on reading the insert back. ──
    const ledgerId = randomUUID();
    const { error: insErr } = await supabase.from("cio_track_events").insert({
      id: ledgerId,
      workspace,
      cio_id: cioId,
      event_name: VOIZO_CALL_FOLLOWUP,
      campaign_id: args.campaignId,
      campaign_number_id: args.campaignNumberId,
      call_id: args.callId,
      status: "queued",
    });
    if (insErr) {
      if (insErr.code === PG_UNIQUE_VIOLATION) {
        // The door: this contact's follow-up already exists (sent, or queued by a concurrent
        // delivery). Refusing here is the feature, not a failure.
        return { fired: false, reason: "duplicate" };
      }
      // No ledger row ⇒ no send. An untracked outbound event is worse than a missed one.
      console.error(`[followup] ledger insert failed for ${args.campaignNumberId}:`, insErr);
      return { fired: false, reason: "ledger_error" };
    }

    // ── the provider call ──
    const result = await sendTrackEvent({
      credential,
      cioId,
      eventName: VOIZO_CALL_FOLLOWUP,
      data: {
        brand: workspace,
        campaign_id: args.campaignId,
        campaign_number_id: args.campaignNumberId,
        call_outcome: args.callOutcome,
        sms_sent: args.smsSent,
      },
    });

    if (result.ok) {
      await supabase
        .from("cio_track_events")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", ledgerId);
      console.log(`[followup] ${VOIZO_CALL_FOLLOWUP} sent ws=${workspace} outcome=${args.callOutcome} sms=${args.smsSent}`);
      return { fired: true, reason: "sent" };
    }

    // 'failed' releases the door (the partial index ignores failed rows) so a later attempt —
    // e.g. a webhook retry after a transient CIO outage — can try again. Mirrors the SMS rule:
    // a provider error must not permanently burn the player's one follow-up.
    await supabase
      .from("cio_track_events")
      .update({ status: "failed", error: result.error })
      .eq("id", ledgerId);
    console.warn(`[followup] Track send failed ws=${workspace}: ${result.error}`);
    return { fired: false, reason: "send_failed" };
  } catch (err) {
    // Absolute backstop: this runs inside the end-of-call webhook. Nothing here may throw.
    console.error(`[followup] unexpected failure (isolated from the webhook):`, err);
    return { fired: false, reason: "ledger_error" };
  }
}
