import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET /api/dashboard/campaigns/[id]/prompt
 *
 * The prompt this campaign's CLONE ran (not the base agent's — the clone's prompt is
 * customized/improved at create time). Sources, in order:
 *   1. prompt_versions snapshots (preferred) — append-only, newest first, with captured
 *      date + sha + full version history (taken on clone/rebind, post-2026-06-03).
 *   2. campaigns_v2.system_prompt — the clone's prompt as stored at CREATE time. Always
 *      present for V2 campaigns and never deleted, so it survives even when the Vapi clone
 *      has been ejected/deleted. Returned as a single {asCreated:true} version.
 *
 * prompt_versions is default-deny RLS → supabaseAdmin (server-only). Ghost-guarded.
 * Read-only; lenient origin.
 */
interface CampRow {
  id: string;
  name?: string | null;
  source?: string | null;
  system_prompt?: string | null;
  created_at?: string | null;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const { id } = await params;

  const { data: campRaw } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, source, system_prompt, created_at")
    .eq("id", id)
    .single();
  const camp = campRaw as CampRow | null;
  if (!camp || camp.source === "ghost_portal") {
    return NextResponse.json({ campaignName: null, versions: [] });
  }
  const campaignName = camp.name ?? null;

  const { data, error } = await supabaseAdmin
    .from("prompt_versions")
    .select("id, system_prompt, prompt_sha256, model_meta, voice_meta, created_at")
    .eq("campaign_id", id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[dashboard/campaigns/prompt] query failed:", error);
    return NextResponse.json({ error: "Failed to read prompt versions" }, { status: 500 });
  }

  if (data && data.length > 0) {
    return NextResponse.json({ campaignName, versions: data });
  }

  // No snapshot — fall back to the prompt stored on the campaign at create time (the
  // clone's authored prompt; survives clone deletion).
  if (camp.system_prompt) {
    return NextResponse.json({
      campaignName,
      versions: [
        {
          id: "campaign",
          system_prompt: camp.system_prompt,
          prompt_sha256: "",
          model_meta: null,
          voice_meta: null,
          created_at: camp.created_at ?? null,
          asCreated: true,
        },
      ],
    });
  }

  return NextResponse.json({ campaignName, versions: [] });
}
