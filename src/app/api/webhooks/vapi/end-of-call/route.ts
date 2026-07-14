import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { processEndOfCall } from "@/lib/webhooks/processEndOfCall";
import { getKillableVoicemailUtterance, resolveControlUrl, endCallViaControlUrl } from "@/lib/vapi/liveCallControl";
import crypto from "crypto";

// SMS dispatch + multiple Supabase queries run inline before returning 200.
// Default Vercel timeout is too tight if Mobivate API is slow.
export const maxDuration = 30;

/**
 * POST /api/webhooks/vapi/end-of-call
 *
 * Vapi posts this when a call ends.
 *
 * Manifesto compliance:
 * - Vapi webhook authenticated via x-vapi-secret token (§6 — per Vapi's documented method)
 * - Idempotent: checks if goal_reached already set on this call (§6)
 * - SMS dispatch is mode-aware (campaigns_v2.sms_consent_mode, 2026-06-11): 'verbal_yes' keeps §6
 *   (goal_reached + consent evidence + sms_enabled + sms_on_goal_reached_only); 'registered_optin'
 *   (client-attested registration opt-in, Val 2026-06-11) sends when the agent announced an SMS.
 *   On-call decline / opt-out / suppression_list veto in BOTH modes; voicemail vetoes
 *   verbal_yes and TRIGGERS the registered_optin missed-call follow-up (2026-06-11).
 * - Call matching uses Vapi's phoneCallProviderId (Twilio SID) — no fragile fallback
 */
export async function POST(request: NextRequest) {
  // ── Read raw body for signature validation ──
  const rawBody = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Vapi webhook authentication (Manifesto §6) ──
  // Vapi's server.secret sends the raw token as the x-vapi-secret header.
  // We validate with constant-time comparison. VAPI_WEBHOOK_SECRET is the
  // dedicated secret (preferred); falls back to VAPI_PRIVATE_KEY for compat.
  const webhookSecret = process.env.VAPI_WEBHOOK_SECRET || process.env.VAPI_PRIVATE_KEY;
  const vapiSecretHeader = request.headers.get("x-vapi-secret");
  if (!webhookSecret) {
    if (process.env.NODE_ENV === "production") {
      console.error("FATAL: VAPI_WEBHOOK_SECRET not set — rejecting webhook");
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 500 });
    }
    console.warn("Vapi webhook: no webhook secret configured (accepting in dev only)");
  } else if (!vapiSecretHeader) {
    console.warn("Vapi webhook: missing x-vapi-secret header — rejecting");
    return NextResponse.json({ error: "Missing signature" }, { status: 403 });
  } else {
    // Constant-time comparison to prevent timing attacks
    const received = Buffer.from(vapiSecretHeader, "utf-8");
    const expected = Buffer.from(webhookSecret, "utf-8");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      console.warn("Vapi webhook: invalid x-vapi-secret — rejecting");
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }
  }

  // ── Parse Vapi payload ──
  const message = body.message as Record<string, unknown> | undefined;

  // ── Live voicemail auto-hangup (2026-07-07) ──
  // Spec: docs/2026-07-07_DOC_Voicemail_Autohangup_LiveClassifier_Spec.md. Val-lineage
  // clones already stream `transcript` serverMessages here (inherited from the base via
  // createClone's `...base` spread); previously they fell through the early-return below.
  // When a FINAL customer utterance is conclusively a voicemail greeting AND the owning
  // campaign opted in (campaigns_v2.voicemail_autohangup), end the call via Live Call
  // Control now — instead of the LLM pitching ~27s into the machine (measured, campaign
  // 46a33f3e). Fail-safe by construction: any error → log + 200 and the call simply
  // continues (prompt rule #4 + silence/maxDuration caps still backstop); non-transcript
  // messages never enter this branch, so the end-of-call flow below is untouched.
  if (message && message.type === "transcript") {
    try {
      const utterance = getKillableVoicemailUtterance(message);
      if (utterance) {
        const call = message.call as Record<string, unknown> | undefined;
        const assistantId = call?.assistantId as string | undefined;
        if (assistantId) {
          // Newest campaign owning this clone — assistant ids can recur across pool
          // rotations, so order by created_at and take the current owner. Known limit
          // (review #6): legacy campaigns sharing the voizo-poc fallback assistant
          // would share the newest owner's flag — moot for dedicated clones; don't
          // enable the flag on legacy shared-assistant campaigns. Until the
          // voicemail_autohangup migration is applied this select errors → data null
          // → no kill (fail-safe, behavior-neutral deploy).
          const { data: camps, error: flagErr } = await supabaseAdmin
            .from("campaigns_v2")
            .select("id, voicemail_autohangup")
            .eq("vapi_assistant_id", assistantId)
            .order("created_at", { ascending: false })
            .limit(1);
          if (flagErr) {
            // Pre-migration or transient DB error — no kill. Log so "kills never
            // fire" is debuggable instead of silent (review #8).
            console.warn(`[voicemail-autohangup] flag lookup failed (no kill): ${flagErr.message}`);
          }
          const camp = camps?.[0] as { id: string; voicemail_autohangup: boolean | null } | undefined;
          if (camp?.voicemail_autohangup === true) {
            const monitor = call?.monitor as Record<string, unknown> | undefined;
            const controlUrl = await resolveControlUrl(
              process.env.VAPI_PRIVATE_KEY ?? "",
              call?.id as string | undefined,
              monitor?.controlUrl as string | undefined,
            );
            if (controlUrl) {
              const kill = await endCallViaControlUrl(controlUrl);
              console.log(
                `[voicemail-autohangup] end-call sent (status=${kill.status}) campaign=${camp.id} ` +
                  `vapiCallId=${call?.id} utterance="${utterance.slice(0, 140)}"`,
              );
            } else {
              console.warn(`[voicemail-autohangup] no controlUrl resolvable vapiCallId=${call?.id}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[voicemail-autohangup] error (call continues, LLM backstop applies):", err);
    }
    return NextResponse.json({ received: true });
  }

  if (!message || message.type !== "end-of-call-report") {
    return NextResponse.json({ received: true });
  }

  return processEndOfCall(message);
}
