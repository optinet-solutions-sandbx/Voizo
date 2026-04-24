import { supabaseAdmin } from "./supabaseServer";
import { twilioClient, twilioPhoneNumber } from "./twilioClient";
import { originateCall } from "./freeswitch/originate";

/**
 * Dialer provider selection. `twilio` keeps the legacy path (still deployed in
 * Vercel at time of writing). `freeswitch` routes outbound through the EC2
 * FreeSWITCH + SquareTalk stack. Default is `twilio` so production stays on
 * the known-working path until FS is verified end-to-end.
 */
const DIALER_PROVIDER = (process.env.DIALER_PROVIDER || "twilio").toLowerCase();

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

  const { data: numbers, error: nErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("*")
    .eq("campaign_id", campaignId)
    .in("outcome", ["pending", "pending_retry"])
    .lt("attempt_count", campaign.max_attempts)
    .order("created_at", { ascending: true })
    .limit(20);

  if (nErr || !numbers || numbers.length === 0) return null;

  // Filter: pending_retry must have next_attempt_at <= now
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
 * Fire an outbound call for the given campaign number. Dispatches to Twilio or
 * FreeSWITCH based on DIALER_PROVIDER. Returns the created calls_v2 row.
 *
 * Manifesto §6: state written to DB before calling provider.
 */
export async function fireCall(
  campaignId: string,
  campaignNumber: { id: string; phone_e164: string },
  vapiAssistantId: string,
  baseUrl: string,
) {
  const provider = DIALER_PROVIDER === "freeswitch" ? "freeswitch" : "twilio";

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
      provider,
      status: "initiated",
    })
    .select()
    .single();

  if (callErr || !callRow) throw new Error("Failed to create call record");

  try {
    let providerCallId: string;

    if (provider === "freeswitch") {
      const callerId = process.env.FREESWITCH_CALLER_ID;
      if (!callerId) {
        throw new Error(
          "FREESWITCH_CALLER_ID not set. Required when DIALER_PROVIDER=freeswitch.",
        );
      }
      const result = await originateCall({
        to: campaignNumber.phone_e164,
        callerId,
        callId: callRow.id,
        vapiAssistantId,
        campaignId,
        numberId: campaignNumber.id,
      });
      providerCallId = result.providerCallId;
    } else {
      const twimlUrl = `${baseUrl}/api/twiml/vapi-bridge?assistantId=${encodeURIComponent(vapiAssistantId)}`;
      const statusCallback = `${baseUrl}/api/webhooks/twilio/voice-status?callId=${callRow.id}&campaignId=${campaignId}&numberId=${campaignNumber.id}`;

      const twilioCall = await twilioClient.calls.create({
        to: campaignNumber.phone_e164,
        from: twilioPhoneNumber,
        url: twimlUrl,
        statusCallback,
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        statusCallbackMethod: "POST",
      });
      providerCallId = twilioCall.sid;
    }

    await supabaseAdmin
      .from("calls_v2")
      .update({ provider_call_id: providerCallId })
      .eq("id", callRow.id);
  } catch (err) {
    // Provider failed — mark the call as failed so we don't leave it dangling
    const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await supabaseAdmin
      .from("calls_v2")
      .update({ status: "failed", ended_at: new Date().toISOString() })
      .eq("id", callRow.id);
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "pending_retry", next_attempt_at: retryAt })
      .eq("id", campaignNumber.id);
    throw err;
  }

  return callRow;
}
