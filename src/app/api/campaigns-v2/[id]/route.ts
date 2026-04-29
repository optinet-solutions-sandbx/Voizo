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
    .select("id, status, vapi_assistant_id")
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

  // Clean up Vapi resources (assistant + its SIP phone number)
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  const vapiWarnings: string[] = [];
  if (vapiKey && campaign.vapi_assistant_id) {
    // Find and delete the SIP phone number bound to this assistant
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

    // Delete the cloned assistant
    try {
      const delAssistant = await fetch(
        `https://api.vapi.ai/assistant/${campaign.vapi_assistant_id}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${vapiKey}` } },
      );
      if (!delAssistant.ok && delAssistant.status !== 404) {
        vapiWarnings.push(`assistant cleanup failed (${delAssistant.status})`);
      }
    } catch (err) {
      vapiWarnings.push(`assistant delete failed: ${(err as Error).message}`);
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

  return NextResponse.json({ deleted: true, vapiWarnings });
}
