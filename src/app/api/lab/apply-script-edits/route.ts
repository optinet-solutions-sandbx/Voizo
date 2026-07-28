// POST /api/lab/apply-script-edits (VOZ-240) — apply a set of in-place edits and
// return the inverse (undo) set. Editing existing handlers/nodes means the script
// is IMPROVED, not duplicated. The response's `undo` array is the exact set of
// edits that restores the prior state — the client keeps it and posts it straight
// back to undo. Apply and undo are the same operation, so this one route does both.
// Operator-only (/api/lab/* is Basic-Auth gated).
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

export const maxDuration = 30;

type Field = "statements" | "opening" | "response_template";
const ALLOWED: Field[] = ["statements", "opening", "response_template"];
type Edit = { kind: "node" | "handler"; id: string; field: Field; value: string | string[] };

export async function POST(request: NextRequest) {
  let body: { edits?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const editsIn = (Array.isArray(body.edits) ? body.edits : []) as Edit[];
  const edits = editsIn.filter(
    (e) => e && (e.kind === "node" || e.kind === "handler") && typeof e.id === "string" && ALLOWED.includes(e.field) &&
      (e.field === "statements" ? Array.isArray(e.value) : typeof e.value === "string"),
  );
  if (!edits.length) return NextResponse.json({ error: "No valid edits." }, { status: 400 });

  const undo: Edit[] = [];
  try {
    for (const e of edits) {
      if (e.kind === "handler") {
        // response_template only.
        const { data, error } = await supabaseAdmin.from("listener_handlers").select("response_template").eq("id", e.id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`handler ${e.id} not found`);
        undo.push({ kind: "handler", id: e.id, field: "response_template", value: (data.response_template ?? "") as string });
        const { error: uErr } = await supabaseAdmin.from("listener_handlers").update({ response_template: e.value as string }).eq("id", e.id);
        if (uErr) throw new Error(uErr.message);
      } else {
        // node config field (statements | opening).
        const { data, error } = await supabaseAdmin.from("listener_script_nodes").select("config").eq("id", e.id).maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) throw new Error(`node ${e.id} not found`);
        const cfg = (data.config ?? {}) as Record<string, unknown>;
        const prev = cfg[e.field];
        // Snapshot the prior value in the same shape (default to empty of the right type).
        undo.push({ kind: "node", id: e.id, field: e.field, value: (e.field === "statements" ? (Array.isArray(prev) ? (prev as string[]) : []) : (typeof prev === "string" ? prev : "")) });
        const { error: uErr } = await supabaseAdmin.from("listener_script_nodes").update({ config: { ...cfg, [e.field]: e.value } }).eq("id", e.id);
        if (uErr) throw new Error(uErr.message);
      }
    }
  } catch (e) {
    // Best-effort rollback of whatever we already applied, so a partial failure
    // doesn't leave the script half-edited.
    for (const u of undo) {
      if (u.kind === "handler") {
        await supabaseAdmin.from("listener_handlers").update({ response_template: u.value as string }).eq("id", u.id);
      } else {
        const { data } = await supabaseAdmin.from("listener_script_nodes").select("config").eq("id", u.id).maybeSingle();
        const cfg = (data?.config ?? {}) as Record<string, unknown>;
        await supabaseAdmin.from("listener_script_nodes").update({ config: { ...cfg, [u.field]: u.value } }).eq("id", u.id);
      }
    }
    return NextResponse.json({ error: `Apply failed (rolled back): ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  return NextResponse.json({ applied: edits.length, undo });
}
