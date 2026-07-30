// GET /api/lab/in-use (VOZ-256) — what a RUNNING campaign is actually using.
//
// A script a running/paused campaign references (campaigns_v2.script_id) is "in
// use"; so are the scenarios its boxes point at, the collections its boxes use,
// and every scenario inside those collections. The Playbook + Script Builder show
// these as locked (production) vs free (test) — mirroring the script lock. Editing
// in-use content can affect a live campaign (it's shared by reference), so the UI
// gates edits behind an explicit unlock. Operator-only (/api/lab/* Basic-Auth gated).
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data: camps } = await supabaseAdmin
      .from("campaigns_v2")
      .select("script_id")
      .in("status", ["running", "paused"])
      .eq("agent_mode", "script");
    const scriptIds = [...new Set((camps ?? []).map((c) => c.script_id as string | null).filter(Boolean))] as string[];

    const scenarioIds = new Set<string>();
    const collectionIds = new Set<string>();

    if (scriptIds.length) {
      const { data: nodes } = await supabaseAdmin
        .from("listener_script_nodes")
        .select("scenario_id, config")
        .in("script_id", scriptIds);
      for (const n of nodes ?? []) {
        if (n.scenario_id) scenarioIds.add(n.scenario_id as string);
        const cfg = (n.config ?? {}) as Record<string, unknown>;
        if (cfg.collectionId) collectionIds.add(cfg.collectionId as string);
        if (cfg.elseCollectionId) collectionIds.add(cfg.elseCollectionId as string);
        for (const id of (cfg.candidateScenarioIds as string[]) ?? []) if (id) scenarioIds.add(id);
      }
    }
    if (collectionIds.size) {
      const { data: members } = await supabaseAdmin
        .from("listener_collection_handlers")
        .select("handler_id")
        .in("collection_id", [...collectionIds]);
      for (const m of members ?? []) if (m.handler_id) scenarioIds.add(m.handler_id as string);
    }

    return NextResponse.json({
      scriptIds,
      collectionIds: [...collectionIds],
      scenarioIds: [...scenarioIds],
    });
  } catch (e) {
    // Best-effort: on failure return empty sets so the UI just shows everything
    // unlocked rather than erroring.
    return NextResponse.json({ scriptIds: [], collectionIds: [], scenarioIds: [], error: e instanceof Error ? e.message : String(e) });
  }
}
