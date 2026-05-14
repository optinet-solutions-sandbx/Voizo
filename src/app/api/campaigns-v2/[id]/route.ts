import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

const DELETABLE_STATUSES = new Set(["draft", "paused", "completed", "archived"]);

/**
 * DELETE /api/campaigns-v2/[id]
 *
 * Deletes a Campaign V2 and all child rows (numbers, calls, SMS)
 * via Postgres ON DELETE CASCADE. Also cleans up the cloned Vapi
 * assistant and its SIP phone number so no orphans are left.
 *
 * Guards:
 * - Origin check: only same-origin requests accepted (blocks external tooling)
 * - Status whitelist: only draft/paused/completed/archived campaigns deletable
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  const { data: campaign, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, status, vapi_assistant_id, vapi_pool_slot_id")
    .eq("id", id)
    .single();

  if (error || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (!DELETABLE_STATUSES.has(campaign.status)) {
    return NextResponse.json(
      { error: `Cannot delete a ${campaign.status} campaign. Pause it first.` },
      { status: 400 },
    );
  }

  // Clean up Vapi resources. Two paths routed by data (NOT by USE_SIP_POOL flag),
  // so flag flips are safe under in-flight campaigns:
  //   - vapi_pool_slot_id present → pool path (PATCH null + release slot)
  //   - vapi_pool_slot_id null    → legacy path (DELETE phone number)
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  const vapiWarnings: string[] = [];
  let slotReleased: string | null = null;

  if (vapiKey && campaign.vapi_assistant_id) {
    if (campaign.vapi_pool_slot_id) {
      // ── Pool path ──
      // Look up the slot by id (no list-and-find needed).
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
          // Detach failed → mark slot maintenance instead of free, so
          // it doesn't get auto-leased again until operator clears it.
          await supabaseAdmin
            .from("vapi_sip_pool")
            .update({
              status: "maintenance",
              notes: `detach failed @ ${new Date().toISOString()}: ${patch.body.slice(0, 200)}`,
            })
            .eq("id", slot.id);
        } else {
          // Detach OK → release the slot back to free.
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
      // Preserved bit-exact from pre-pool code.
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

    // ── Common: delete the cloned assistant ──
    // Both pool and legacy paths still delete the per-campaign clone.
    //
    // SAFETY GUARD (added 2026-05-15 after incident): verify the assistant
    // is actually a voizoClone before deleting. Old campaigns (pre-clone-per-
    // campaign architecture, before metadata.voizoClone existed) sometimes
    // reference base agents directly in their vapi_assistant_id field. Without
    // this guard, deleting an old campaign deletes the BASE agent — which
    // breaks future campaign creation for everyone using that base. Verified
    // real: 2026-05-15 incident lost "Ernie - Voice Agent" (production base)
    // when an old "ERNIE FIRST LIVE TEST" paused campaign was deleted via
    // the dashboard. ~8 other campaigns currently carry the same risk shape.
    //
    // Approach: GET the assistant first, inspect metadata.voizoClone, only
    // DELETE if true. If false/missing, log loudly and skip — preserves the
    // base agent at the cost of an orphan clone left on Vapi (small standing
    // cost, manually cleanable, far cheaper than losing a base).
    try {
      const inspectRes = await fetch(
        `https://api.vapi.ai/assistant/${campaign.vapi_assistant_id}`,
        { headers: { Authorization: `Bearer ${vapiKey}` } },
      );
      if (inspectRes.status === 404) {
        // Already gone (e.g. earlier hand-cleanup or 404 race) — nothing to do
      } else if (!inspectRes.ok) {
        vapiWarnings.push(`assistant inspect failed (${inspectRes.status}); skipped delete for safety`);
      } else {
        const assistant = await inspectRes.json();
        if (assistant.metadata?.voizoClone === true) {
          // Safe to delete — this is a Voizo-managed clone
          const delAssistant = await fetch(
            `https://api.vapi.ai/assistant/${campaign.vapi_assistant_id}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${vapiKey}` } },
          );
          if (!delAssistant.ok && delAssistant.status !== 404) {
            vapiWarnings.push(`assistant cleanup failed (${delAssistant.status})`);
          }
        } else {
          // NOT a Voizo clone — refuse to delete. This is the safety net for
          // base agents and pre-metadata-stamp legacy clones.
          console.warn(
            `[campaigns-v2] REFUSED to delete assistant ${campaign.vapi_assistant_id} ` +
            `(name: "${assistant.name ?? 'unknown'}") — metadata.voizoClone is not true. ` +
            `Possible base agent or pre-metadata clone. Manual Vapi cleanup needed if intentional.`,
          );
          vapiWarnings.push(`assistant not a voizoClone — skipped delete for safety`);
        }
      }
    } catch (err) {
      vapiWarnings.push(`assistant inspect/delete failed: ${(err as Error).message}`);
    }
  }

  const { error: deleteErr } = await supabaseAdmin
    .from("campaigns_v2")
    .delete()
    .eq("id", id);

  if (deleteErr) {
    console.error("[campaigns-v2] delete failed:", deleteErr);
    return NextResponse.json({ error: "Failed to delete campaign" }, { status: 500 });
  }

  if (vapiWarnings.length > 0) {
    console.warn("[campaigns-v2] vapi cleanup warnings:", vapiWarnings);
  }

  return NextResponse.json({
    deleted: true,
    vapiWarnings,
    ...(slotReleased ? { slotReleased } : {}),
  });
}
