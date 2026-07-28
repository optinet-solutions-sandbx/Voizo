// Design-time script simulator (VOZ-234) — the observer's covered/owed/missing
// idea, run at SCRIPT-CREATION time instead of on a live call. Pure graph
// analysis (no IO, no LLM, no Vapi credits): enumerate the flow's paths and,
// per path, check whether the content the boxes DELIVER covers every Call Goal,
// whether any goal is delivered twice (repetition risk), and whether the path
// reaches an End. Answers "is this script complete + will it hit all goals
// without repeating" before anyone dials.
//
// Modeling choices (deliberately conservative):
//   • "Delivered" = the content a box says PROACTIVELY and deterministically —
//     the Start opening, node statements, and a scenario/end/SMS box's own line.
//     Collections push a MENU the model picks from, so their members are NOT
//     counted as guaranteed delivery (only a collection box's statements are).
//   • Goal match reuses the live matcher (salientTokens): reword- & number-
//     tolerant, authoring words stripped — so "Mention the 20 Free Spins" is
//     covered by a beat that says "twenty free spins".
import type { ListenerScriptNode, ListenerScriptEdge, ListenerHandler } from "./database.types";
import { salientTokens } from "./lab-sentences";
import { contentTypeOf } from "./lab-flow";

type Graph = { nodes: ListenerScriptNode[]; edges: ListenerScriptEdge[] };
const cfgOf = (n: ListenerScriptNode) => (n.config ?? {}) as Record<string, unknown>;
const TERMINAL = new Set(["end", "transfer", "return"]);

const MAX_PATHS = 400;
const MAX_DEPTH = 40;
const MAX_REVISIT = 2; // allow Q&A self-loops / repeats to unroll a bounded number of times

/** The content a box delivers proactively & deterministically. */
function deliveredText(n: ListenerScriptNode, byId: Map<string, ListenerHandler>): string {
  // A Call Goal box is the checklist itself — it SPEAKS nothing. Counting its
  // statements would make every goal trivially "covered" by its own text.
  if (contentTypeOf(n) === "call_goal") return "";
  const cfg = cfgOf(n);
  const parts: string[] = [];
  if (n.type === "start" && typeof cfg.opening === "string") parts.push(cfg.opening);
  for (const s of (cfg.statements as unknown[]) ?? []) if (typeof s === "string") parts.push(s);
  const ct = contentTypeOf(n);
  if ((ct === "scenario" || ct === "end" || ct === "send_sms") && n.scenario_id) {
    const h = byId.get(n.scenario_id);
    if (h?.response_template) parts.push(h.response_template);
  }
  return parts.join(" ");
}

/** Does a box's token set carry enough of a goal's salient tokens to count as
 *  delivering it? (≥60% overlap, mirroring the live sentence check.) */
function covers(goalTokens: string[], boxTokens: Set<string>): boolean {
  if (goalTokens.length < 2) return false;
  const hit = goalTokens.filter((t) => boxTokens.has(t)).length;
  return hit / goalTokens.length >= 0.6;
}

/** Gather the Call Goals authored in the graph (call_goal boxes' statements). */
export function goalsOf(graph: Graph): string[] {
  const out: string[] = [];
  for (const n of graph.nodes) {
    if (contentTypeOf(n) !== "call_goal") continue;
    for (const s of ((cfgOf(n).statements as unknown[]) ?? [])) {
      const t = typeof s === "string" ? s.trim() : "";
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

type PathRaw = { nodes: ListenerScriptNode[]; reachesEnd: boolean };

function enumeratePaths(graph: Graph): PathRaw[] {
  const entry = graph.nodes.find((n) => n.type === "start")
    ?? graph.nodes.find((n) => !graph.edges.some((e) => e.target_node_id === n.id) && contentTypeOf(n) !== "call_goal")
    ?? graph.nodes.find((n) => contentTypeOf(n) !== "call_goal");
  if (!entry) return [];
  const paths: PathRaw[] = [];
  const dfs = (node: ListenerScriptNode, acc: ListenerScriptNode[], visits: Map<string, number>) => {
    if (paths.length >= MAX_PATHS) return;
    const path = [...acc, node];
    const outs = graph.edges.filter((e) => e.source_node_id === node.id);
    const terminal = TERMINAL.has(contentTypeOf(node));
    if (terminal || outs.length === 0 || path.length >= MAX_DEPTH) {
      paths.push({ nodes: path, reachesEnd: terminal });
      return;
    }
    for (const e of outs) {
      const target = graph.nodes.find((x) => x.id === e.target_node_id);
      if (!target) continue;
      const vc = visits.get(target.id) ?? 0;
      if (vc >= MAX_REVISIT) continue;
      const next = new Map(visits);
      next.set(target.id, vc + 1);
      dfs(target, path, next);
    }
  };
  dfs(entry, [], new Map([[entry.id, 1]]));
  return paths;
}

const labelOf = (n: ListenerScriptNode) => n.label || contentTypeOf(n);

export type SimGoalReport = {
  text: string;
  everCovered: boolean; // delivered on at least one path
  guaranteed: boolean; // delivered on EVERY path that reaches an End
  missedEndPaths: number; // # of End-reaching paths where it's NOT delivered
  deliveredBy: string[]; // box labels that deliver it anywhere
};
export type SimPathReport = { labels: string[]; reachesEnd: boolean; missing: string[]; repeatedGoals: string[] };
export type SimIssue = { level: "error" | "warn"; text: string };
export type SimReport = {
  goals: SimGoalReport[];
  paths: SimPathReport[];
  endPaths: number;
  deadEndPaths: number;
  issues: SimIssue[];
  ok: boolean;
};

export function simulateScript(graph: Graph, handlers: ListenerHandler[], goalsInput?: string[]): SimReport {
  const goals = (goalsInput && goalsInput.length ? goalsInput : goalsOf(graph)).map((g) => g.trim()).filter(Boolean);
  const byId = new Map(handlers.map((h) => [h.id, h] as const));
  const paths = enumeratePaths(graph);
  const endPaths = paths.filter((p) => p.reachesEnd);

  // Precompute each box's delivered-token set (once).
  const boxTokens = new Map<string, Set<string>>();
  for (const n of graph.nodes) boxTokens.set(n.id, new Set(salientTokens(deliveredText(n, byId))));
  const goalTokens = goals.map((g) => ({ text: g, toks: salientTokens(g) }));

  // Global: which boxes deliver each goal.
  const deliveredBy = new Map<string, string[]>();
  for (const g of goalTokens) {
    const boxes = graph.nodes.filter((n) => covers(g.toks, boxTokens.get(n.id)!)).map(labelOf);
    deliveredBy.set(g.text, [...new Set(boxes)]);
  }

  const pathReports: SimPathReport[] = paths.map((p) => {
    const missing: string[] = [];
    const repeated: string[] = [];
    for (const g of goalTokens) {
      const delivering = p.nodes.filter((n) => covers(g.toks, boxTokens.get(n.id)!));
      const distinct = new Set(delivering.map((n) => n.id));
      if (distinct.size === 0) missing.push(g.text);
      if (distinct.size >= 2) repeated.push(g.text);
    }
    return { labels: p.nodes.map(labelOf), reachesEnd: p.reachesEnd, missing, repeatedGoals: repeated };
  });

  const goalReports: SimGoalReport[] = goalTokens.map((g) => {
    const boxes = deliveredBy.get(g.text) ?? [];
    const missedEndPaths = pathReports.filter((p) => p.reachesEnd && p.missing.includes(g.text)).length;
    return {
      text: g.text,
      everCovered: boxes.length > 0,
      guaranteed: endPaths.length > 0 && missedEndPaths === 0,
      missedEndPaths,
      deliveredBy: boxes,
    };
  });

  const issues: SimIssue[] = [];
  for (const g of goalReports) {
    if (!g.everCovered) issues.push({ level: "error", text: `Goal never spoken anywhere in the script: “${g.text}”. No box delivers it.` });
    else if (!g.guaranteed) issues.push({ level: "warn", text: `Goal “${g.text}” is missed on ${g.missedEndPaths} of ${endPaths.length} completed paths (e.g. if the customer wraps up early).` });
    if (g.deliveredBy.length >= 2) issues.push({ level: "warn", text: `Repetition risk — “${g.text}” is authored in ${g.deliveredBy.length} boxes (${g.deliveredBy.join(", ")}); the agent may say it more than once.` });
  }
  const deadEndPaths = paths.filter((p) => !p.reachesEnd).length;
  if (endPaths.length === 0) issues.push({ level: "error", text: "No path reaches an End box — the agent can never close the call itself." });
  else if (deadEndPaths > 0) issues.push({ level: "warn", text: `${deadEndPaths} path(s) never reach an End box (the call would park there).` });
  if (goals.length === 0) issues.push({ level: "warn", text: "No Call Goals defined — add a Call Goal box to check the script delivers the offer." });

  return {
    goals: goalReports,
    paths: pathReports,
    endPaths: endPaths.length,
    deadEndPaths,
    issues,
    ok: !issues.some((i) => i.level === "error"),
  };
}
