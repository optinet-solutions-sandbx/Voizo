// Goal-driven script assembly (VOZ-236). The LLM produces only CONTENT (a
// plan: opener, ordered offer beats, anticipated Q&A, close); this pure module
// assembles a VALID Script Builder graph from that plan deterministically — so
// generation can never emit a broken flow (routing/connectors are ours, not the
// model's). The result is a starter script to review, then validated by the
// simulator (VOZ-234) before it's offered.
//
// Server-side (uses node:crypto for ids); the builder calls the endpoint, never
// this module directly.
import { randomUUID } from "node:crypto";

export type PlanBeat = { label: string; line: string };
export type PlanConcern = { name: string; when: string; answer: string };
export type ScriptPlan = {
  name: string;
  persona: string;
  opening: string;
  beats: PlanBeat[];
  concerns: PlanConcern[];
  goals: string[];
  close: string;
};

type HandlerRow = {
  id: string; name: string; intent_key: string; description: string; response_template: string;
  action_type: string; delivery: string; tags: string[]; mode: string; enabled: boolean; priority: number;
};
type NodeRow = { id: string; type: string; label: string; config: Record<string, unknown>; scenario_id: string | null; pos_x: number; pos_y: number };
type EdgeRow = { id: string; source_node_id: string; target_node_id: string; condition: Record<string, unknown>; label: string };

export type AssembledScript = {
  name: string;
  persona: string;
  handlers: HandlerRow[];
  collectionId: string;
  collectionName: string;
  collectionHandlerIds: string[];
  nodes: NodeRow[];
  edges: EdgeRow[];
};

const slug = (s: string, fallback: string) =>
  (s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || fallback);

const anyConn = () => ({ id: "c:" + randomUUID(), intentKey: "", any: true as const });

/** Validate + normalise a raw LLM plan into a safe ScriptPlan (never throws). */
export function normalizePlan(raw: unknown, fallbackBrand: string): ScriptPlan {
  const p = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, d = "") => (typeof v === "string" ? v.trim() : d);
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const beats = arr(p.beats).map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    return { label: str(o.label, "Beat"), line: str(o.line) };
  }).filter((b) => b.line).slice(0, 8);
  const concerns = arr(p.concerns).map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return { name: str(o.name, "Concern"), when: str(o.when), answer: str(o.answer) };
  }).filter((c) => c.answer && c.when).slice(0, 12);
  const goals = arr(p.goals).map((g) => str(g)).filter(Boolean).slice(0, 8);
  return {
    name: str(p.name, `${fallbackBrand} — generated`),
    persona: str(p.persona),
    opening: str(p.opening, "Hi, quick question — do you have a moment?"),
    beats: beats.length ? beats : [{ label: "Main point", line: str(p.opening, "I wanted to share a quick update with you.") }],
    concerns,
    goals,
    close: str(p.close, "Thanks so much for your time — have a great day!"),
  };
}

/** Deterministically build a valid graph: Start → beat₁ … beatₙ → Wrap(collection)
 *  → End, plus a floating Call Goal box. All connectors are `any` (advance on any
 *  reply); the concern collection is the off-path answer bank + the End close. */
export function buildScriptFromPlan(plan: ScriptPlan): AssembledScript {
  // intent_key is a UNIQUE routing id across the whole table — a deterministic
  // slug (gen_beat_0_free_spins) collides the moment two scripts are generated
  // with similar goals. A per-generation nonce keeps them readable AND unique.
  const nonce = randomUUID().slice(0, 6);
  const handlers: HandlerRow[] = [];
  const mkHandler = (h: Partial<HandlerRow> & { intent_key: string; response_template: string; name: string }): HandlerRow => {
    const row: HandlerRow = {
      id: randomUUID(), enabled: true, mode: "both", priority: 50, delivery: "reword", action_type: "answer",
      description: "", tags: [], ...h,
    } as HandlerRow;
    handlers.push(row);
    return row;
  };

  // Beat scenarios (proactive), tagged fact:<slug> so the observer dedupes them.
  const beatHandlers = plan.beats.map((b, i) =>
    mkHandler({
      name: `Gen - ${b.label}`, intent_key: `gen_${nonce}_beat_${i}_${slug(b.label, String(i))}`,
      description: `proactively cover: ${b.label}`, response_template: b.line,
      tags: ["gen", `fact:beat_${i}`],
    }),
  );
  // Concern scenarios (Q&A collection members).
  const concernHandlers = plan.concerns.map((c, i) =>
    mkHandler({
      name: `Gen - ${c.name}`, intent_key: `gen_${nonce}_concern_${i}_${slug(c.name, String(i))}`,
      description: c.when, response_template: c.answer, tags: ["gen"],
    }),
  );
  // Close (reworded goodbye).
  const closeHandler = mkHandler({
    name: "Gen - Close", intent_key: `gen_${nonce}_close`, description: "warm close",
    response_template: plan.close, action_type: "end_call", tags: ["gen"],
  });

  // Nodes
  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  let y = 0;
  const startConn = anyConn();
  const start: NodeRow = { id: randomUUID(), type: "start", label: "Start call", config: { mode: "agent_first", opening: plan.opening, openingDelivery: "reword", connectors: [startConn] }, scenario_id: null, pos_x: 0, pos_y: y };
  nodes.push(start);
  let prev = start, prevConn = startConn;
  for (const bh of beatHandlers) {
    y += 150;
    const conn = anyConn();
    const n: NodeRow = { id: randomUUID(), type: "step", label: bh.name.replace("Gen - ", ""), config: { contentType: "scenario", connectors: [conn] }, scenario_id: bh.id, pos_x: 0, pos_y: y };
    nodes.push(n);
    edges.push({ id: randomUUID(), source_node_id: prev.id, target_node_id: n.id, condition: { kind: "any", handle: prevConn.id }, label: "" });
    prev = n; prevConn = conn;
  }
  // Wrap (collection of concerns) — off-path answers + "anything else?" statement.
  y += 150;
  const collectionId = randomUUID();
  const wrapConn = anyConn();
  const wrap: NodeRow = { id: randomUUID(), type: "step", label: "Questions & wrap", config: { contentType: "collection", collectionId, statements: ["Warmly ask if they have any questions before you let them go."], connectors: [wrapConn] }, scenario_id: null, pos_x: 0, pos_y: y };
  nodes.push(wrap);
  edges.push({ id: randomUUID(), source_node_id: prev.id, target_node_id: wrap.id, condition: { kind: "any", handle: prevConn.id }, label: "" });
  // End
  y += 150;
  const end: NodeRow = { id: randomUUID(), type: "step", label: "End call", config: { contentType: "end" }, scenario_id: closeHandler.id, pos_x: 0, pos_y: y };
  nodes.push(end);
  edges.push({ id: randomUUID(), source_node_id: wrap.id, target_node_id: end.id, condition: { kind: "any", handle: wrapConn.id }, label: "" });
  // Floating Call Goal box (no edges).
  if (plan.goals.length) {
    nodes.push({ id: randomUUID(), type: "step", label: "Call Goal", config: { contentType: "call_goal", statements: plan.goals }, scenario_id: null, pos_x: 360, pos_y: 60 });
  }

  return {
    name: plan.name,
    persona: plan.persona,
    handlers,
    collectionId,
    collectionName: `${plan.name} — Concerns`,
    collectionHandlerIds: concernHandlers.map((h) => h.id),
    nodes,
    edges,
  };
}
