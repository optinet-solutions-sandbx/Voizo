import { NextRequest, NextResponse } from "next/server";
// Relative imports (vitest does not resolve "@/"; same convention as the
// ghost routes — keeps this route unit-testable).
import { supabaseAdmin } from "../../../../lib/supabaseServer";
import { parseSigningKeys, verifyCioSignature } from "../../../../lib/customerioWebhookAuth";
import { claimAndQueueMember, findTodaysChild } from "../../../../lib/scheduler/realtimeAdmission";
import { decideAdmission, expectedCountryForTimezone } from "../../../../lib/scheduler/realtimePoll";

/**
 * POST /api/webhooks/customerio — the push lane for real-time campaigns
 * (VOZ-180 — docs/2026-07-21_SPEC_CustomerIO_Webhook_Ingress.md).
 *
 * Customer.io side: a campaign (trigger: person enters segment) with a
 * "Send and receive data" action POSTing:
 *   { "cio_id": "{{customer.cio_id}}", "phone": "{{customer.phone}}",
 *     "first_name": "{{customer.first_name}}", "segment_id": <static id> }
 *
 * Voizo side, per delivery:
 *   1. Verify the CIO HMAC signature (v0:<ts>:<body>, workspace key map in
 *      CUSTOMERIO_WEBHOOK_SIGNING_KEYS). Fail CLOSED on missing config.
 *   2. Route by segment_id → running realtime parents. None → 200 no-op
 *      (dormant-safe: with no realtime campaigns this endpoint does nothing).
 *   3. Admit through the SAME door as the poll (decideAdmission +
 *      claimAndQueueMember): country vs campaign timezone, race-safe claim.
 *      The claim PK is what makes push + poll + CIO retries collision-proof
 *      — nobody is ever dialed twice for one campaign. Non-admit verdicts
 *      (blank/odd/wrong-country payload phone) claim NOTHING — the poll
 *      re-resolves them with full profile attrs + lookup fallback (spec §5.3).
 *   4. "Not now" cases (no child today / capped child / operator call delay)
 *      claim as 'waiting' — the poll's promotion pass feeds them into the
 *      next child with room, and is the only cap enforcer (a webhook-side
 *      count is a race across concurrent deliveries). NEVER 5xx for these:
 *      CIO stops retrying after ~1 hour — an overnight 5xx loses the player.
 *
 * Response contract (spec §5.7):
 *   200 handled / duplicate / no-op → stops CIO retries
 *   400 structurally-broken payload (misconfigured template; visible in CIO UI)
 *   401 bad signature / missing key config → stops CIO retries
 *   5xx only when WE are broken (DB errors) → CIO retries; idempotent by claims
 *
 * Security posture (manifesto: Defensive by Default): the payload is
 * untrusted even after the signature passes — phone re-parsed, country
 * re-checked, cap re-counted server-side. Phones are masked in logs/Slack.
 * Middleware already exempts /api/webhooks/* from Basic Auth; the signature
 * IS this route's auth (same pattern as the Vapi/Mobivate webhooks).
 *
 * Cost note: this route spends nothing (no CIO/Vapi/SMS calls). It can only
 * accelerate dials already authorized by the campaign's cap + call windows.
 */

interface CioWebhookPayload {
  cio_id: string;
  phone: string | null;
  first_name?: string | null;
  segment_id: number;
}

interface ParentRow {
  id: string;
  name: string;
  timezone: string;
  call_delay_minutes: number | null;
}

export async function POST(request: NextRequest) {
  // ── 1. Authenticity ──
  const keys = parseSigningKeys(process.env.CUSTOMERIO_WEBHOOK_SIGNING_KEYS);
  const rawBody = await request.text();
  const verdict = verifyCioSignature({
    rawBody,
    timestampHeader: request.headers.get("x-cio-timestamp"),
    signatureHeader: request.headers.get("x-cio-signature"),
    keys,
    nowMs: Date.now(),
  });
  if (!verdict.ok) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  // TODO(multi-workspace): segment ids are only unique per workspace — route
  // by (verdict.workspace, segment_id) before adding a second signing key.
  console.log(`[cio-webhook] verified delivery from workspace ${verdict.workspace}`);

  // ── 2. Payload shape ──
  // A payload with NO "phone" key at all means the CIO template is broken —
  // 400 (no claims!) so the misconfiguration is visible in the CIO UI instead
  // of permanently set-asiding every player as no_phone. An empty/invalid
  // phone VALUE is a per-member condition and claims normally, same as the poll.
  let payload: CioWebhookPayload;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (
      typeof parsed !== "object" || parsed === null ||
      typeof (parsed as Record<string, unknown>).cio_id !== "string" ||
      !(parsed as Record<string, unknown>).cio_id ||
      !Number.isInteger((parsed as Record<string, unknown>).segment_id) ||
      !("phone" in (parsed as Record<string, unknown>))
    ) {
      return NextResponse.json(
        { error: "Body must include cio_id (string), segment_id (number), phone (key required)" },
        { status: 400 },
      );
    }
    const obj = parsed as Record<string, unknown>;
    payload = {
      cio_id: obj.cio_id as string,
      phone: typeof obj.phone === "string" ? obj.phone : null,
      first_name: typeof obj.first_name === "string" ? obj.first_name : null,
      segment_id: obj.segment_id as number,
    };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 3. Route to running realtime parents by segment ──
  const { data: parents, error: parentsErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, timezone, call_delay_minutes")
    .eq("campaign_type", "recurring")
    .eq("status", "running")
    .eq("realtime", true)
    .eq("segment_id", payload.segment_id);
  if (parentsErr) {
    console.error("[cio-webhook] parents query failed:", parentsErr);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  if (!parents || parents.length === 0) {
    return NextResponse.json({ handled: false, results: [] });
  }

  const displayName = payload.first_name?.trim() || null;
  const now = new Date();
  const results: Array<{ parentId: string; outcome: string }> = [];
  let internalError = false;

  for (const p of parents as ParentRow[]) {
    // ── 4. Validate the payload phone + country. ANY non-admit verdict is
    //       deferred to the poll (spec §5.3): it re-resolves the member ≤1 min
    //       later with full profile attrs + the lookup fallback, and owns the
    //       batched wrong-country alert. A blank/odd payload phone must never
    //       permanently claim (and thus hide) a member the poll could admit.
    const decision = decideAdmission({
      rawPhone: payload.phone,
      expectedCountry: expectedCountryForTimezone(p.timezone),
      addedToday: 0,
      dailyCap: null,
    });
    // dailyCap:null makes capBlocked unreachable; the guard is for the types.
    if ("capBlocked" in decision) continue;
    if (!decision.admit) {
      results.push({ parentId: p.id, outcome: "deferred_to_poll" });
      continue;
    }
    const phone = decision.phone;

    // ── 5. Today's child (shared lookup — one contract for both lanes) ──
    const { ok: childOk, child } = await findTodaysChild(supabaseAdmin, p.id, p.timezone, now);
    if (!childOk) {
      internalError = true;
      continue;
    }

    // Capped children ALWAYS buffer as 'waiting': the poll's promotion pass is
    // the single sequential writer that enforces the cap. A webhook-side
    // count-then-insert is a TOCTOU race across concurrent deliveries — a
    // signup burst would blow straight past the cap. Cost: ≤1 tick of latency.
    const capGated = !!child && (child.daily_cap as number | null) != null;
    const delayActive = p.call_delay_minutes != null;
    const queueNow = !!child && !delayActive && !capGated;
    const claimStatus = queueNow ? "queued" : "waiting";

    // ── 6. One door: race-safe claim (+ dial row when queueing now) ──
    const result = await claimAndQueueMember(supabaseAdmin, {
      parentId: p.id,
      parentName: p.name,
      cioId: payload.cio_id,
      phone,
      claimStatus,
      childId: queueNow ? (child!.id as string) : null,
      displayName,
    });

    if (!result.won) {
      if (result.reason === "duplicate") {
        results.push({ parentId: p.id, outcome: "duplicate" });
      } else {
        internalError = true; // claim_error / insert_failed → 500, CIO retries, claims dedupe
      }
      continue;
    }

    results.push({ parentId: p.id, outcome: result.queued ? "queued" : "waiting" });
    if (result.queued) {
      console.log(`[cio-webhook] ${p.name}: +1 player queued into ${child!.name as string}`);
    }
  }

  if (internalError) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
  return NextResponse.json({ handled: true, results });
}
