// Pure graph-walk helpers for the Script runtime (no DB/IO).
import type { ListenerScriptNode, ListenerScriptEdge } from "./database.types";

export function findStartNode(nodes: ListenerScriptNode[]): ListenerScriptNode | null {
  return nodes.find((n) => n.type === "start") ?? null;
}

/** Entry node: a Start box if present, else a box with no incoming edge, else the first box.
 *  Lets a (sub-)workflow omit a Start box and just begin at its root. */
export function findEntryNode(
  nodes: ListenerScriptNode[],
  edges: ListenerScriptEdge[]
): ListenerScriptNode | null {
  const start = nodes.find((n) => n.type === "start");
  if (start) return start;
  const targeted = new Set(edges.map((e) => e.target_node_id));
  return nodes.find((n) => !targeted.has(n.id)) ?? nodes[0] ?? null;
}

export function nodeById(nodes: ListenerScriptNode[], id: string | null): ListenerScriptNode | null {
  if (!id) return null;
  return nodes.find((n) => n.id === id) ?? null;
}

/** The content a Step box runs (new model in config.contentType; legacy in node.type). */
export function contentTypeOf(node: ListenerScriptNode): string {
  if (node.type === "start") return "start";
  const ct = (node.config as Record<string, unknown>)?.contentType as string | undefined;
  if (ct) return ct;
  // legacy node.type → content
  if (node.type === "say" || node.type === "switch") return "scenario";
  if (node.type === "send_sms") return "send_sms";
  if (node.type === "transfer") return "transfer";
  if (node.type === "end") return "end";
  return "noop";
}

type Cond = { kind?: string; by?: string; value?: string; handle?: string };
function cond(e: ListenerScriptEdge): Cond {
  return (e.condition ?? {}) as Cond;
}
function handleOf(e: ListenerScriptEdge): string {
  return cond(e).handle ?? "out";
}

export type FlowCtx = {
  intent: string;
  /** All intents the utterance addressed (multi-part replies); primary first. */
  intents?: string[];
  tags: string[];
  result: string | null;
};

/**
 * Pick the outgoing edge to follow from a node. Reply connectors carry the
 * routing: a connector whose reply matches wins (customer's primary intent
 * first), then the "any other reply" catch-all, then a plain default edge.
 * With connectors and no catch-all/default, stay parked (null) — the
 * Playbook answers and the box re-checks on the next reply.
 */
export function pickNextEdge(
  node: ListenerScriptNode,
  edges: ListenerScriptEdge[],
  ctx: FlowCtx
): ListenerScriptEdge | null {
  // Silence paths ({kind:"timeout"}) never fire on a spoken turn — only the
  // poll-driven silence advance (checkWaitTimeout) walks them.
  const outs = edges.filter((e) => e.source_node_id === node.id && cond(e).kind !== "timeout");
  if (outs.length === 0) return null;

  const conditional = outs.filter((e) => {
    const c = cond(e);
    return c.kind === "intent" || c.kind === "tag" || c.kind === "any";
  });
  if (conditional.length) {
    // When a multi-part reply matches SEVERAL connectors, the customer's
    // PRIMARY point routes: intents are checked in the router's importance
    // order — never edge-creation order, which made the winner depend on
    // which arrow happened to be drawn first.
    for (const key of ctx.intents ?? [ctx.intent]) {
      for (const e of conditional) {
        const c = cond(e);
        if ((c.by ?? c.kind) === "intent" && c.value === key) return e;
      }
    }
    for (const e of conditional) {
      const c = cond(e);
      const by = c.by ?? c.kind;
      if (by === "tag" && c.value && ctx.tags.includes(c.value)) return e;
      if (by === "result" && ctx.result && c.value === ctx.result) return e;
    }
    return outs.find((e) => cond(e).kind === "any") ?? outs.find((e) => handleOf(e) === "out") ?? null;
  }

  // Plain: first outgoing connector.
  return outs[0] ?? null;
}
