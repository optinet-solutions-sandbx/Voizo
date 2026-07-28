// POST /api/lab/improve-script (VOZ-240) — suggest concrete script improvements.
//
// Reads the SAVED script and proposes a small set of edits that remove semantic
// repetition (the same point said twice, reworded) and close coverage gaps —
// each edit targets ONE existing element (a box's statements/opener, or a
// scenario/collection line) by a stable handle, so nothing is duplicated. This
// endpoint only PROPOSES; /api/lab/apply-script-edits applies + captures undo.
// Operator-only (/api/lab/* is Basic-Auth gated).
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { goalsOf } from "@/lib/scriptEngine/scriptSimulator";
import { contentTypeOf } from "@/lib/scriptEngine/lab-flow";
import type { ListenerScriptNode, ListenerScriptEdge, ListenerHandler } from "@/lib/scriptEngine/database.types";

export const maxDuration = 60;
const MODEL = "gpt-5.4-mini";
const cfgOf = (n: ListenerScriptNode) => (n.config ?? {}) as Record<string, unknown>;
const lineOf = (h: ListenerHandler | undefined) => (h?.response_template ?? "").trim();

type Field = "statements" | "opening" | "response_template";
type Editable = { handle: string; kind: "node" | "handler"; id: string; field: Field; label: string; current: string | string[] };

const PROMPT = `You improve outbound phone-call scripts for a voice AI. The script below tends to REPEAT itself — the agent says the same point more than once across boxes, even when reworded (re-introducing itself, re-stating the offer, re-explaining a benefit, re-promising the SMS). Your job: propose a SMALL set of concrete edits that fix this.

Rules:
- Keep each key point in ONE place (usually its first, most natural spot); trim or reword the later restatements into short transitions instead of full repeats.
- Keep EVERY goal covered exactly once. Do not drop a goal. Do not invent offer terms, prices, or facts not already in the script.
- Preserve the agent's voice and keep lines short and spoken-natural.
- You may ONLY edit the elements listed under EDITABLE, referenced by their handle.
- For a "statements" element, return the FULL replacement array (you may remove or reword items, or return [] to clear it). For "opening"/"response_template", return the replacement string.
- Group edits into a few labelled suggestions. Fewer, higher-impact suggestions are better than many tiny ones.

Return ONLY JSON:
{
  "suggestions": [
    { "title": "<short label>", "reason": "<what repetition/gap this fixes>", "edits": [ { "handle": "<E#>", "value": <string OR array of strings> } ] }
  ]
}`;

export async function POST(request: NextRequest) {
  let body: { scriptId?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const scriptId = typeof body.scriptId === "string" ? body.scriptId : "";
  if (!scriptId) return NextResponse.json({ error: "Missing scriptId — save the script first." }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  const { data: nodesRaw } = await supabaseAdmin.from("listener_script_nodes").select("*").eq("script_id", scriptId);
  const { data: edgesRaw } = await supabaseAdmin.from("listener_script_edges").select("*").eq("script_id", scriptId);
  const nodes = (nodesRaw ?? []) as ListenerScriptNode[];
  const edges = (edgesRaw ?? []) as ListenerScriptEdge[];
  if (!nodes.length) return NextResponse.json({ error: "Script has no boxes to improve." }, { status: 400 });

  // Fetch referenced handlers + collection members.
  const scenarioIds = new Set<string>();
  const collectionIds = new Set<string>();
  for (const n of nodes) {
    if (n.scenario_id) scenarioIds.add(n.scenario_id);
    const cfg = cfgOf(n);
    if (cfg.collectionId) collectionIds.add(cfg.collectionId as string);
    if (cfg.elseCollectionId) collectionIds.add(cfg.elseCollectionId as string);
  }
  const memberIdsByCol = new Map<string, string[]>();
  const memberIds = new Set<string>();
  for (const cid of collectionIds) {
    const { data } = await supabaseAdmin.from("listener_collection_handlers").select("handler_id").eq("collection_id", cid);
    const ids = (data ?? []).map((r) => r.handler_id as string);
    memberIdsByCol.set(cid, ids);
    ids.forEach((id) => memberIds.add(id));
  }
  const allIds = [...new Set([...scenarioIds, ...memberIds])];
  const { data: hs } = allIds.length ? await supabaseAdmin.from("listener_handlers").select("*").in("id", allIds) : { data: [] as ListenerHandler[] };
  const byId = new Map((hs ?? []).map((h) => [h.id, h as ListenerHandler] as const));

  // Build the editable inventory (handle -> element) + a readable dump for the LLM.
  const editables: Editable[] = [];
  const lines: string[] = [];
  let seq = 0;
  const nextHandle = () => `E${++seq}`;
  for (const n of nodes) {
    const ct = contentTypeOf(n);
    if (ct === "call_goal") continue;
    const cfg = cfgOf(n);
    const box = n.label || ct;
    if (n.type === "start" && typeof cfg.opening === "string" && cfg.opening.trim()) {
      const h = nextHandle();
      editables.push({ handle: h, kind: "node", id: n.id, field: "opening", label: `${box} — opener`, current: cfg.opening.trim() });
      lines.push(`${h} [${box}] opening (string): "${cfg.opening.trim()}"`);
    }
    const stmts = ((cfg.statements as unknown[]) ?? []).filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (stmts.length) {
      const h = nextHandle();
      editables.push({ handle: h, kind: "node", id: n.id, field: "statements", label: `${box} — statements`, current: stmts });
      lines.push(`${h} [${box}] statements (array): ${JSON.stringify(stmts)}`);
    }
    if ((ct === "scenario" || ct === "end" || ct === "send_sms") && n.scenario_id) {
      const l = lineOf(byId.get(n.scenario_id));
      if (l) {
        const h = nextHandle();
        editables.push({ handle: h, kind: "handler", id: n.scenario_id, field: "response_template", label: `${box} — line`, current: l });
        lines.push(`${h} [${box}] line (string): "${l}"`);
      }
    }
    if (ct === "collection" && cfg.collectionId) {
      for (const id of memberIdsByCol.get(cfg.collectionId as string) ?? []) {
        const m = byId.get(id);
        const l = lineOf(m);
        if (l) {
          const h = nextHandle();
          const nm = m?.description || m?.name || "answer";
          editables.push({ handle: h, kind: "handler", id, field: "response_template", label: `${box} — "${nm}"`, current: l });
          lines.push(`${h} [${box}] answer to "${nm}" (string): "${l}"`);
        }
      }
    }
  }
  const goals = goalsOf({ nodes, edges });
  const byHandle = new Map(editables.map((e) => [e.handle, e] as const));

  const user = `GOALS (each must stay covered exactly once):\n${goals.map((g, i) => `  ${i + 1}. ${g}`).join("\n") || "  (none defined)"}\n\nEDITABLE elements (edit ONLY these, by handle):\n${lines.join("\n")}`;

  let raw: { suggestions?: unknown } = {};
  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 50000, maxRetries: 1 });
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: PROMPT }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      max_completion_tokens: 2600,
    } as unknown as Parameters<typeof openai.chat.completions.create>[0]);
    raw = JSON.parse((completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "{}");
  } catch (e) {
    return NextResponse.json({ error: `Suggestion failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  // Resolve handles -> concrete, validated edits (before from current DB value).
  const norm = (v: unknown, field: Field): string | string[] | null => {
    if (field === "statements") {
      if (!Array.isArray(v)) return null;
      const a = v.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
      return a; // [] is valid (clears the box)
    }
    return typeof v === "string" ? v.trim() : null;
  };
  const same = (a: string | string[], b: string | string[]) => JSON.stringify(a) === JSON.stringify(b);

  const suggestions = (Array.isArray(raw.suggestions) ? raw.suggestions : []).map((s) => {
    const o = (s ?? {}) as Record<string, unknown>;
    const edits = (Array.isArray(o.edits) ? o.edits : []).map((e) => {
      const eo = (e ?? {}) as Record<string, unknown>;
      const el = byHandle.get(String(eo.handle ?? ""));
      if (!el) return null;
      const after = norm(eo.value, el.field);
      if (after === null || same(after, el.current)) return null; // no-op or wrong type
      return { kind: el.kind, id: el.id, field: el.field, label: el.label, before: el.current, after };
    }).filter(Boolean);
    return { title: typeof o.title === "string" ? o.title : "Improvement", reason: typeof o.reason === "string" ? o.reason : "", edits };
  }).filter((s) => s.edits.length > 0).slice(0, 8);

  return NextResponse.json({ suggestions });
}
