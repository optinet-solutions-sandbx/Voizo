// POST /api/lab/simulate-script (VOZ-239) — REAL design-time simulation.
//
// No phone call, no Vapi credits: the LLM plays out full conversations between
// the AGENT (following the script) and a CUSTOMER (a given persona), so the
// operator can READ 10 varied transcripts and see how calls would actually go —
// coverage, objection handling, and where the agent repeats itself. We also run:
//  • a deterministic structural pass (dead ends / unreachable / never-said goals);
//  • a script-level read-through that flags SEMANTIC repetition (same point, reworded).
// Operator-only (/api/lab/* is Basic-Auth gated).
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { simulateScript, goalsOf } from "@/lib/scriptEngine/scriptSimulator";
import { contentTypeOf } from "@/lib/scriptEngine/lab-flow";
import type { ListenerScriptNode, ListenerScriptEdge, ListenerHandler } from "@/lib/scriptEngine/database.types";

export const maxDuration = 60;

const MODEL = "gpt-5.4-mini";
const cfgOf = (n: ListenerScriptNode) => (n.config ?? {}) as Record<string, unknown>;
const lineOf = (h: ListenerHandler | undefined) => (h?.response_template ?? "").trim();

// The customer types we play the script against — chosen to exercise different
// paths: eager, skeptical, opt-out, the repeat-asker (the repetition stress test), etc.
const PERSONAS: { key: string; label: string; behavior: string }[] = [
  { key: "eager", label: "Eager & receptive", behavior: "You're glad they called and interested in the offer. Say yes fairly quickly and ask how to claim it." },
  { key: "skeptical", label: "Skeptical — thinks it's a scam", behavior: "You suspect a scam. Push back, ask if it's legit and who they really are, and need reassurance before engaging." },
  { key: "busy", label: "Busy — 'just text me'", behavior: "You're in a hurry and can't talk long. Ask them to just text you the details and try to get off the phone politely." },
  { key: "inquisitive", label: "Lots of questions", behavior: "You're interested but ask several questions in turn: how do I claim it, what are the terms, when does it expire, is it really free." },
  { key: "repeat", label: "Asks them to repeat", behavior: "You keep mishearing and repeatedly ask the agent to repeat the offer and the numbers ('sorry — how many free spins? say that again')." },
  { key: "notinterested", label: "Not interested", behavior: "You're not interested and try to decline politely but firmly early in the call." },
  { key: "optout", label: "Opt-out / do not contact", behavior: "You're annoyed and ask to be removed — do not call or text me again." },
  { key: "confused", label: "Confused — 'who is this?'", behavior: "You're confused about who is calling and why. Give short answers and keep asking who they are and how they got you." },
  { key: "chatty", label: "Chatty regular", behavior: "You already play with this brand and are chatty and positive, wandering into small tangents before getting back on track." },
  { key: "privacy", label: "Privacy-concerned", behavior: "Your main worry is how they got your number and what they'll do with your data; you keep coming back to that." },
];

/** A readable dump of everything the script would SAY, box by box, so the model
 *  can play the agent faithfully and reference boxes by name. */
function readable(graph: { nodes: ListenerScriptNode[]; edges: ListenerScriptEdge[] }, byId: Map<string, ListenerHandler>, members: Map<string, ListenerHandler[]>, goals: string[], persona: string): string {
  const out: string[] = [];
  for (const n of graph.nodes) {
    const ct = contentTypeOf(n);
    if (ct === "call_goal") continue;
    const cfg = cfgOf(n);
    const parts: string[] = [];
    if (n.type === "start" && typeof cfg.opening === "string" && cfg.opening.trim()) parts.push(`opens with: "${cfg.opening.trim()}"`);
    for (const s of (cfg.statements as unknown[]) ?? []) if (typeof s === "string" && s.trim()) parts.push(`says: "${s.trim()}"`);
    if ((ct === "scenario" || ct === "end" || ct === "send_sms") && n.scenario_id) {
      const l = lineOf(byId.get(n.scenario_id));
      if (l) parts.push(`line: "${l}"`);
    }
    if (ct === "collection" && cfg.collectionId) {
      for (const m of members.get(cfg.collectionId as string) ?? []) if (lineOf(m)) parts.push(`if asked "${m.description || m.name}", answers: "${lineOf(m)}"`);
    }
    if (parts.length) out.push(`[${n.label || ct}]\n  ${parts.join("\n  ")}`);
  }
  return `GOALS the agent must cover during the call:\n${goals.map((g, i) => `  ${i + 1}. ${g}`).join("\n") || "  (none defined)"}\n\nSCRIPT — what the agent has to work with:\n${out.join("\n\n")}\n\nCUSTOMER for this call: ${persona}`;
}

const CONVO_SYS = `You simulate a realistic outbound phone call so an operator can preview a call SCRIPT without spending call credits. Produce the FULL transcript between two speakers:
- AGENT: a voice AI that follows the SCRIPT. It opens with the opener, proactively delivers the script's points, answers the customer's questions from the script's answer bank, works the GOALS in naturally over the call, and closes. Stay faithful to the script — if the script is repetitive or has gaps, LET THAT SHOW; do not fix the script's flaws for it.
- CUSTOMER: a real person who behaves exactly as described.
Keep it natural and spoken (short lines). Usually 5-12 exchanges, ending when the call wraps up. Then assess the transcript HONESTLY.

Return ONLY JSON:
{
  "transcript": [ { "speaker": "agent" | "customer", "text": "<spoken line>" } ],
  "goalsCovered": [ { "goal": "<goal text>", "covered": true|false } ],
  "repetition": [ { "point": "<a point the AGENT stated more than once in THIS call, even if reworded>", "count": <number of times> } ],
  "endedCleanly": true|false,
  "notes": "<one short line: how did this call go?>"
}`;

const REVIEW_SYS = `You are reviewing an outbound call script by reading it. Find points or facts the AGENT would end up saying MORE THAN ONCE across the call, EVEN IF WORDED DIFFERENTLY (same idea, different words — re-introducing itself, re-stating the offer, re-explaining a benefit in two boxes/answers). Judge by MEANING, not exact words.
Return ONLY JSON: { "repetition": [ { "point": "<the repeated idea>", "boxes": ["<box name>", ...], "severity": "high"|"medium"|"low" } ], "summary": "<one-sentence verdict>" }`;

export async function POST(request: NextRequest) {
  let body: { nodes?: unknown; edges?: unknown; count?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const nodes = (Array.isArray(body.nodes) ? body.nodes : []) as ListenerScriptNode[];
  const edges = (Array.isArray(body.edges) ? body.edges : []) as ListenerScriptEdge[];
  if (!nodes.length) return NextResponse.json({ error: "No script to simulate." }, { status: 400 });
  const count = Math.max(1, Math.min(10, typeof body.count === "number" ? body.count : 10));

  // Fetch the handlers this script references (box lines) + collection members.
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
  const members = new Map<string, ListenerHandler[]>();
  for (const [cid, ids] of memberIdsByCol) members.set(cid, ids.map((id) => byId.get(id)).filter((h): h is ListenerHandler => !!h));

  const graph = { nodes, edges };
  const goals = goalsOf(graph);
  const structural = simulateScript(graph, (hs ?? []) as ListenerHandler[]);

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ structural, goals, conversations: [], review: null, reviewError: "OPENAI_API_KEY not configured — structural checks only." });
  }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 50000, maxRetries: 1 });

  async function jsonCall(system: string, user: string, maxTokens: number): Promise<Record<string, unknown> | null> {
    try {
      const params: Record<string, unknown> = {
        model: MODEL,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        max_completion_tokens: maxTokens,
      };
      const completion = await openai.chat.completions.create(params as unknown as Parameters<typeof openai.chat.completions.create>[0]);
      return JSON.parse((completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "{}");
    } catch {
      return null;
    }
  }

  const chosen = PERSONAS.slice(0, count);
  // Run the conversations + the read-through in parallel.
  const [convosRaw, reviewRaw] = await Promise.all([
    Promise.all(chosen.map((p) => jsonCall(CONVO_SYS, readable(graph, byId, members, goals, p.behavior), 1700).then((j) => ({ p, j })))),
    jsonCall(REVIEW_SYS, readable(graph, byId, members, goals, "reviewer only — no persona"), 900),
  ]);

  type Turn = { speaker: string; text: string };
  const conversations = convosRaw.map(({ p, j }) => {
    const t = (Array.isArray(j?.transcript) ? j!.transcript : []) as Turn[];
    return {
      persona: p.label,
      behavior: p.behavior,
      failed: !j,
      transcript: t.filter((x) => x && typeof x.text === "string").map((x) => ({ speaker: x.speaker === "customer" ? "customer" : "agent", text: String(x.text) })),
      goalsCovered: (Array.isArray(j?.goalsCovered) ? j!.goalsCovered : []) as { goal: string; covered: boolean }[],
      repetition: (Array.isArray(j?.repetition) ? j!.repetition : []) as { point: string; count?: number }[],
      endedCleanly: j?.endedCleanly !== false,
      notes: typeof j?.notes === "string" ? j!.notes : "",
    };
  });

  return NextResponse.json({ structural, goals, conversations, review: reviewRaw, reviewError: null });
}
