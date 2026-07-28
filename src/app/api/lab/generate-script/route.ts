// POST /api/lab/generate-script (VOZ-236) — goal-driven script generation.
//
// Body: { goals: string[], brand: string, persona?: string, model?: string }
// The LLM produces only CONTENT (a plan); scriptGenerator assembles a VALID
// graph deterministically, we persist it (handlers → collection → script →
// nodes → edges), then self-check it with the simulator and return the id +
// report. Operator-only: /api/lab/* is Basic-Auth gated in middleware.
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { buildScriptFromPlan, normalizePlan } from "@/lib/scriptEngine/scriptGenerator";
import { simulateScript } from "@/lib/scriptEngine/scriptSimulator";

export const maxDuration = 60;

const PROMPT = `You design outbound phone-call scripts for a voice AI. Given a brand and the GOALS the call must accomplish, produce a short, natural call plan.

Return ONLY JSON of this exact shape:
{
  "name": "<short script name>",
  "persona": "<1-2 sentences: who the agent is, the brand, tone>",
  "opening": "<the agent's first line — a warm, brief opener that earns a moment>",
  "beats": [ { "label": "<2-4 words>", "line": "<what the agent proactively says to deliver ONE goal, in a natural sentence>" } ],
  "concerns": [ { "name": "<2-4 words>", "when": "<when the customer raises this>", "answer": "<a short reassuring answer>" } ],
  "goals": [ "<one call goal, phrased with concrete NOUNS (not just numbers) so it's checkable>" ],
  "close": "<a warm goodbye line>"
}

Rules:
- One beat per goal, in a sensible order. Each beat's line must actually deliver that goal using distinctive content words (e.g. "free spins", "deposit bonus"), not only numbers.
- Keep every line short and spoken-natural (no markdown, no lists inside lines).
- concerns = a RICH anticipated-questions bank of 7-10 members (this becomes a Collection of multiple scenarios). Always cover, at minimum: who is calling / which brand, is this legit or a scam, how did you get my number, not interested, "don't text me" / opt-out, how do I claim or use the offer, and 2-3 more that fit THIS brand and offer (e.g. can't log in / forgot password, wagering or terms, is it free, when does it expire). Each concern has a distinct "when" (the customer's trigger) and a short "answer".
- goals = the required checklist (echo the user's goals, tightened to concrete nouns).
- Never invent prices/terms the user didn't provide; keep specifics only from the goals.`;

export async function POST(request: NextRequest) {
  let body: { goals?: unknown; brand?: unknown; persona?: unknown; model?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const goals = Array.isArray(body.goals) ? body.goals.filter((g) => typeof g === "string" && g.trim()).map((g) => (g as string).trim()) : [];
  const brand = typeof body.brand === "string" && body.brand.trim() ? body.brand.trim() : "New brand";
  const persona = typeof body.persona === "string" ? body.persona.trim() : "";
  if (!goals.length) return NextResponse.json({ error: "Provide at least one goal." }, { status: 400 });
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

  // ── 1. LLM plan (content only) ──
  const model = typeof body.model === "string" && body.model ? body.model : "gpt-5.4-mini";
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000, maxRetries: 1 });
  const params: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: `Brand: ${brand}\n${persona ? `Persona hint: ${persona}\n` : ""}Goals the call must accomplish:\n${goals.map((g) => `- ${g}`).join("\n")}` },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 2600,
  };
  if (!model.startsWith("gpt-5")) {
    params.temperature = 0.4;
    params.max_tokens = 2600;
    delete params.max_completion_tokens;
  }
  let raw: unknown;
  try {
    const completion = await openai.chat.completions.create(params as unknown as Parameters<typeof openai.chat.completions.create>[0]);
    const content = (completion as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "{}";
    raw = JSON.parse(content);
  } catch (e) {
    return NextResponse.json({ error: `Generation failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  // ── 2. Normalise + assemble a valid graph deterministically ──
  const plan = normalizePlan(raw, brand);
  if (persona && !plan.persona) plan.persona = persona;
  if (!plan.goals.length) plan.goals = goals; // never lose the user's checklist
  const a = buildScriptFromPlan(plan);

  // ── 3. Persist: handlers → collection → script → nodes → edges ──
  try {
    if (a.handlers.length) {
      const { error } = await supabaseAdmin.from("listener_handlers").insert(a.handlers);
      if (error) throw new Error("handlers: " + error.message);
    }
    const { error: colErr } = await supabaseAdmin.from("listener_collections").insert({ id: a.collectionId, name: a.collectionName, description: "Generated concern answers (VOZ-236)." });
    if (colErr) throw new Error("collection: " + colErr.message);
    if (a.collectionHandlerIds.length) {
      const { error } = await supabaseAdmin.from("listener_collection_handlers").insert(a.collectionHandlerIds.map((handler_id) => ({ collection_id: a.collectionId, handler_id })));
      if (error) throw new Error("collection_handlers: " + error.message);
    }
    const { data: script, error: sErr } = await supabaseAdmin
      .from("listener_scripts")
      .insert({ name: a.name, description: `Generated from goals (VOZ-236) — review before use.`, collection_id: a.collectionId, ...(a.persona ? { persona: a.persona } : {}) })
      .select("id")
      .single();
    if (sErr) throw new Error("script: " + sErr.message);
    const scriptId = script.id as string;
    const nodes = a.nodes.map((n) => ({ ...n, script_id: scriptId }));
    const edges = a.edges.map((e) => ({ ...e, script_id: scriptId }));
    if (nodes.length) { const { error } = await supabaseAdmin.from("listener_script_nodes").insert(nodes); if (error) throw new Error("nodes: " + error.message); }
    if (edges.length) { const { error } = await supabaseAdmin.from("listener_script_edges").insert(edges); if (error) throw new Error("edges: " + error.message); }

    // ── 4. Self-check with the simulator ──
    const sim = simulateScript(
      { nodes: nodes as unknown as Parameters<typeof simulateScript>[0]["nodes"], edges: edges as unknown as Parameters<typeof simulateScript>[0]["edges"] },
      a.handlers as unknown as Parameters<typeof simulateScript>[1],
    );
    return NextResponse.json({ scriptId, name: a.name, goals: plan.goals, sim });
  } catch (e) {
    return NextResponse.json({ error: `Persist failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }
}
