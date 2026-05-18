import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

// Vapi cleanup chains up to 3 HTTP calls (PATCH phone detach, GET clone inspect,
// DELETE clone). 30s mirrors the stop endpoint's defensive budget.
export const maxDuration = 30;

const EJECTABLE_STATUSES = ["draft", "paused", "completed", "archived"] as const;
type EjectableStatus = (typeof EJECTABLE_STATUSES)[number];
const EJECTABLE_SET = new Set<string>(EJECTABLE_STATUSES);

/**
 * POST /api/campaigns-v2/[id]/eject
 *
 * Releases a campaign's SIP slot and deletes its Vapi clone while
 * PRESERVING the campaign row + all dial/call/SMS history. Status flips
 * from {draft, paused, completed, archived} → 'inactive'. The inverse
 * of Re-bind (Phase 1 Step 4, not yet shipped).
 *
 * Differs from DELETE /api/campaigns-v2/[id]:
 *   - DELETE drops campaigns_v2 + cascade-drops campaign_numbers_v2,
 *     calls_v2, sms_messages_v2. Permanent.
 *   - Eject keeps all of that; only clears the three Vapi-pointer fields
 *     (vapi_assistant_id, vapi_pool_slot_id, vapi_sip_uri) so the slot
 *     can be re-leased and the campaign stays cleanly resumable.
 *
 * The Vapi-cleanup block below is intentionally duplicated from the
 * DELETE handler at campaigns-v2/[id]/route.ts:50-175 (same shape: pool
 * path PATCH+release-or-maintenance, legacy path phone-number delete,
 * voizoClone-guarded clone delete). Per the 2026-05-18 working
 * agreement: extraction is deferred until a third caller justifies it.
 *
 * Guards:
 *   - Origin check: URL-parsed exact host equality (matches stop/route.ts
 *     pattern; the older origin.includes(host) used by the DELETE handler
 *     is bypassable via subdomain confusion).
 *   - Status whitelist: only {draft, paused, completed, archived} ejectable.
 *     A `running` campaign must be paused first.
 *   - Atomic terminal UPDATE: re-checks status IN whitelist in the WHERE
 *     clause. Protects against an operator-clicked Resume between our
 *     SELECT and UPDATE — 0 rows matched → 409 (the Vapi cleanup already
 *     ran, but the campaign row is left in whatever state Resume put it).
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §4.3, §4.4
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §3
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Origin check (URL-parsed exact host equality) ──
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  // ── 1. Read the campaign and validate status ──
  const { data: campaign, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, vapi_assistant_id, vapi_pool_slot_id")
    .eq("id", id)
    .single();

  if (selectErr || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (!EJECTABLE_SET.has(campaign.status as string)) {
    const friendly =
      campaign.status === "running"
        ? "Cannot eject a running campaign. Pause it first."
        : campaign.status === "inactive"
          ? "Campaign is already inactive."
          : `Cannot eject a ${campaign.status} campaign.`;
    return NextResponse.json({ error: friendly, ejected: false }, { status: 400 });
  }

  const campaignName = (campaign.name as string) ?? id;
  const previousStatus = campaign.status as EjectableStatus;

  // ── 2. Vapi cleanup (mirrors DELETE handler) ──
  // Two paths routed by data, NOT by USE_SIP_POOL flag — keeps flag flips
  // safe under in-flight campaigns:
  //   - vapi_pool_slot_id present → pool path
  //   - vapi_pool_slot_id null    → legacy per-campaign SIP path
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  const vapiWarnings: string[] = [];
  let slotReleased: string | null = null;

  if (vapiKey && campaign.vapi_assistant_id) {
    if (campaign.vapi_pool_slot_id) {
      // ── Pool path ──
      const { data: slot } = await supabaseAdmin
        .from("vapi_sip_pool")
        .select("id, slot_index, vapi_phone_number_id")
        .eq("id", campaign.vapi_pool_slot_id)
        .maybeSingle();

      if (slot) {
        // PATCH null FIRST (detach assistant from SIP route) so no in-flight
        // call hits a just-deleted assistant.
        const { patchPhoneAssistant, releaseSlot } = await import("@/lib/vapi/sipPool");
        const patch = await patchPhoneAssistant(vapiKey, slot.vapi_phone_number_id, null);
        if (!patch.ok) {
          vapiWarnings.push(`pool detach failed (${patch.status})`);
          // Detach failed → mark slot maintenance so it doesn't get auto-leased
          // again until operator clears it.
          await supabaseAdmin
            .from("vapi_sip_pool")
            .update({
              status: "maintenance",
              notes: `eject detach failed @ ${new Date().toISOString()}: ${patch.body.slice(0, 200)}`,
            })
            .eq("id", slot.id);
        } else {
          const released = await releaseSlot(supabaseAdmin, slot.id).catch((err: Error) => {
            vapiWarnings.push(`pool release failed: ${err.message}`);
            return false;
          });
          if (released) {
            slotReleased = `voizo-sip-pool-slot-${String(slot.slot_index).padStart(2, "0")}`;
          }
        }
      } else {
        vapiWarnings.push(`pool slot ${campaign.vapi_pool_slot_id} not found in vapi_sip_pool`);
      }
    } else {
      // ── Legacy path (per-campaign SIP) ──
      // Preserved bit-exact from the DELETE handler's pre-pool code.
      try {
        const phonesRes = await fetch("https://api.vapi.ai/phone-number", {
          headers: { Authorization: `Bearer ${vapiKey}`, Accept: "application/json" },
        });
        if (phonesRes.ok) {
          const phones = await phonesRes.json();
          const match = phones.find(
            (p: { assistantId?: string }) => p.assistantId === campaign.vapi_assistant_id,
          );
          if (match?.id) {
            const delPhone = await fetch(`https://api.vapi.ai/phone-number/${match.id}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${vapiKey}` },
            });
            if (!delPhone.ok) {
              vapiWarnings.push(`phone cleanup failed (${delPhone.status})`);
            }
          }
        }
      } catch (err) {
        vapiWarnings.push(`phone lookup failed: ${(err as Error).message}`);
      }
    }

    // ── Common: delete the cloned assistant (with voizoClone safety guard) ──
    // The guard is the same one that protects DELETE from the 2026-05-15
    // incident where deleting an old paused campaign nuked the base agent
    // (see campaigns-v2/[id]/route.ts:124-174 for the original incident
    // commentary). GET assistant → require metadata.voizoClone === true →
    // only then DELETE. If guard fails: log loudly, leave the (likely-base)
    // assistant alive, accept the orphan clone as the lesser evil.
    try {
      const inspectRes = await fetch(
        `https://api.vapi.ai/assistant/${campaign.vapi_assistant_id}`,
        { headers: { Authorization: `Bearer ${vapiKey}` } },
      );
      if (inspectRes.status === 404) {
        // Already gone — nothing to do.
      } else if (!inspectRes.ok) {
        vapiWarnings.push(
          `assistant inspect failed (${inspectRes.status}); skipped delete for safety`,
        );
      } else {
        const assistant = await inspectRes.json();
        if (assistant.metadata?.voizoClone === true) {
          const delAssistant = await fetch(
            `https://api.vapi.ai/assistant/${campaign.vapi_assistant_id}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${vapiKey}` } },
          );
          if (!delAssistant.ok && delAssistant.status !== 404) {
            vapiWarnings.push(`assistant cleanup failed (${delAssistant.status})`);
          }
        } else {
          console.warn(
            `[campaigns-v2/eject] REFUSED to delete assistant ${campaign.vapi_assistant_id} ` +
            `(name: "${assistant.name ?? "unknown"}") — metadata.voizoClone is not true. ` +
            `Possible base agent or pre-metadata clone. Manual Vapi cleanup needed if intentional.`,
          );
          vapiWarnings.push(`assistant not a voizoClone — skipped delete for safety`);
        }
      }
    } catch (err) {
      vapiWarnings.push(`assistant inspect/delete failed: ${(err as Error).message}`);
    }
  }

  // ── 3. Terminal status flip ──
  // .in("status", EJECTABLE_STATUSES) guards against an operator-clicked
  // Resume that flipped the row to 'running' while we were doing Vapi work.
  // If 0 rows match here, the Vapi cleanup already happened but the DB row
  // moved on — return 409 so the operator can re-sync from the dashboard.
  // base_assistant_id, system_prompt, timezone, name, callWindows etc. are
  // all preserved by virtue of not appearing in the SET clause.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update({
      status: "inactive",
      vapi_assistant_id: null,
      vapi_pool_slot_id: null,
      vapi_sip_uri: null,
    })
    .eq("id", id)
    .in("status", EJECTABLE_STATUSES as unknown as string[])
    .select("id")
    .single();

  if (updateErr || !updated) {
    console.error(`[campaigns-v2/eject] status flip lost the race for ${id}:`, updateErr);
    return NextResponse.json(
      {
        error:
          "Campaign status changed during eject (someone clicked Resume?). " +
          "Vapi cleanup may have partially completed — refresh the dashboard and retry if needed.",
        ejected: false,
      },
      { status: 409 },
    );
  }

  if (vapiWarnings.length > 0) {
    console.warn(
      `[campaigns-v2/eject] vapi cleanup warnings for ${campaignName}:`,
      vapiWarnings,
    );
  }

  // Audit log — structured single line for post-incident review.
  console.log(
    `[campaigns-v2/eject] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName,
      previousStatus,
      slotReleased,
      vapiWarnings,
      timestamp: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    ejected: true,
    campaignId: id,
    campaignName,
    previousStatus,
    ...(slotReleased ? { slotReleased } : {}),
    vapiWarnings,
  });
}
