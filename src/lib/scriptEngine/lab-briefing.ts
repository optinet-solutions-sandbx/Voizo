// Server-only: the brief-ahead compiler. The Script Builder graph is no
// longer interpreted reactively (classify → pick line → inject → hope the
// trigger lands); instead each node's OUTGOING neighborhood is compiled into
// a "[CURRENT STAGE]" briefing pushed to the model BEFORE the customer's
// next turn — while the agent is still talking, which is free time. The
// model then answers natively at VAPI speed, choosing among the authored
// lines; the engine's runtime job shrinks to navigation (flow state, the
// next briefing), actions (SMS / hangup / transfer) and auditing.
import type { ListenerHandler, ListenerScriptNode, ListenerScriptEdge } from "./database.types";
import { getCollectionHandlerIds, agentSaidCorpus, visitedFlowNodeIds, getDeliveredHandlers } from "./lab-db";
import { contentTypeOf } from "./lab-flow";

type Graph = { nodes: ListenerScriptNode[]; edges: ListenerScriptEdge[] };
type Cfg = Record<string, unknown>;
/** Observer context threaded through the compiler: what the agent has
 *  already said (as word stems), the facts already conveyed anywhere in the
 *  call (fact-level coverage, VOZ-177), and a tally of the marks made. */
type ObserverCtx = { corpusStems?: Set<string>; counter?: { covered: number }; coveredFacts?: Set<string> };

// Fact-level coverage (VOZ-177). A handler tagged `fact:<key>` declares that
// its line conveys a shared fact (identity, the free-spins offer, "SMS anyway"…).
// The per-line stem observer is blind to the SAME fact reworded in a different
// scenario — the exact repetition seen on the Val test call, where five distinct
// members each re-introduced "Victor from Lucky Seven". Tagging lets the observer
// dedupe at the fact level: once a fact has been conveyed under ANY wording, every
// sibling line that conveys it is marked covered. A handler may carry several tags.
const FACT_TAG_PREFIX = "fact:";
export function factsOf(h: ListenerHandler): string[] {
  return (h.tags ?? [])
    .filter((t) => t.startsWith(FACT_TAG_PREFIX))
    .map((t) => t.slice(FACT_TAG_PREFIX.length).trim())
    .filter(Boolean);
}

const MEMBER_CAP = 12;

// ── Observer pass: covered-ground detection ───────────────────
// Deliveries are REWORDED, so exact matching is useless — compare word
// STEMS (first 5 chars of significant words) instead: "registration" spoken
// as "registered" still counts. A false positive only downgrades a line to
// "rephrase, don't recite" — the line itself is never removed.
const stemsOf = (text: string): string[] => [...new Set((text.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 5)))];

export function contentCovered(line: string, corpusStems: Set<string> | undefined): boolean {
  if (!corpusStems || corpusStems.size === 0) return false;
  const stems = stemsOf(line);
  if (stems.length < 3) return false;
  const hit = stems.filter((s) => corpusStems.has(s)).length;
  return hit / stems.length >= 0.6;
}

const COVERED_MARK = " — ALREADY COVERED earlier in this call: don't recite it again; one short rephrase at most, only if they ask";

function markIfCovered(rendered: string, sourceText: string | null | undefined, obs: ObserverCtx | undefined): string {
  if (!obs || !sourceText || !contentCovered(sourceText, obs.corpusStems)) return rendered;
  if (obs.counter) obs.counter.covered++;
  return rendered + COVERED_MARK;
}

/** Handler-aware covered check. A menu line is covered when its OWN wording is
 *  already in the corpus (per-line stem overlap) OR — the fact-level pass
 *  (VOZ-177) — when any fact it conveys has already been delivered under
 *  DIFFERENT wording somewhere in this call. The second arm is what the
 *  per-line check is blind to: it stops distinct scenarios that restate the
 *  same fact (identity, the offer, "SMS anyway") from re-pitching it. */
function markIfCoveredHandler(rendered: string, h: ListenerHandler, obs: ObserverCtx | undefined): string {
  if (!obs) return rendered;
  const byStem = contentCovered(h.response_template, obs.corpusStems);
  const byFact = !byStem && !!obs.coveredFacts?.size && factsOf(h).some((f) => obs.coveredFacts!.has(f));
  if (!byStem && !byFact) return rendered;
  if (obs.counter) obs.counter.covered++;
  return rendered + COVERED_MARK;
}

const cfgOf = (n: ListenerScriptNode): Cfg => (n.config ?? {}) as Cfg;
const isAnyEdge = (e: ListenerScriptEdge): boolean => {
  const c = (e.condition ?? {}) as Cfg;
  return ((c.by as string) ?? (c.kind as string)) === "any";
};

/** A line, framed by its delivery choice. Authored lines are often written
 *  as instructions ("Explain that…") — the reword framing covers both. */
function renderLine(h: ListenerHandler): string {
  const t = (h.response_template ?? "").trim();
  return h.delivery === "verbatim"
    ? `say EXACTLY, word for word: "${t}"`
    : `say in your own words (keep facts, numbers and terms exact): "${t}"`;
}

/** Disabled boxes pass through silently at runtime — briefings follow the
 *  same wire so the menu describes what will actually be said. */
function resolveThroughDisabled(graph: Graph, targetId: string): ListenerScriptNode | null {
  let node = graph.nodes.find((n) => n.id === targetId) ?? null;
  for (let hops = 0; node && cfgOf(node).disabled === true && hops < 5; hops++) {
    const out = graph.edges.find((e) => e.source_node_id === node!.id);
    node = out ? graph.nodes.find((n) => n.id === out.target_node_id) ?? null : null;
  }
  return node;
}

/** What the target box wants said, as menu text for the model. */
async function targetSays(node: ListenerScriptNode, byId: Map<string, ListenerHandler>, handlers: ListenerHandler[], obs?: ObserverCtx): Promise<string> {
  const cfg = cfgOf(node);
  const ct = contentTypeOf(node);
  const statements = (((cfg.statements as string[]) ?? []).map((s) => (s ?? "").trim()).filter(Boolean));
  const rider = statements.length
    ? `\n  Then ALWAYS continue in the SAME reply with: ${statements.map((s) => markIfCovered(`"${s}"`, s, obs)).join(" …then… ")} (if it reads as an instruction to you, do what it says in the customer's language — never read instruction wording aloud).`
    : "";

  if (ct === "scenario") {
    const cand = (node.scenario_id ? byId.get(node.scenario_id) : undefined) ?? byId.get(((cfg.candidateScenarioIds as string[]) ?? [])[0] ?? "");
    const line = cand?.response_template?.trim()
      ? `  ${markIfCoveredHandler(renderLine(cand), cand, obs)}`
      : `  (no line authored here — bridge with ONE short, neutral sentence; invent nothing, ask nothing)`;
    return line + rider;
  }

  if (ct === "collection") {
    const ids = cfg.collectionId ? await getCollectionHandlerIds(cfg.collectionId as string).catch(() => [] as string[]) : [];
    const members = handlers.filter((h) => ids.includes(h.id) && h.enabled && (h.response_template ?? "").trim() && h.action_type !== "ignore");
    const shown = members.slice(0, MEMBER_CAP);
    const lines = shown.map((h) => `  - If ${h.description?.trim() || h.name}: ${markIfCoveredHandler(renderLine(h), h, obs)}`);
    if (members.length > shown.length) lines.push(`  - (${members.length - shown.length} more exist — if one clearly fits, answer in the same spirit and length.)`);
    // The else ladder, in the same order the engine used to walk it:
    // written else line → else collection → neutral bridge.
    const elseHandler = node.scenario_id ? byId.get(node.scenario_id) : undefined;
    if (elseHandler?.response_template?.trim()) {
      lines.push(`  - If NOTHING above fits: ${markIfCoveredHandler(renderLine(elseHandler), elseHandler, obs)}`);
    } else if (cfg.elseCollectionId) {
      const eids = await getCollectionHandlerIds(cfg.elseCollectionId as string).catch(() => [] as string[]);
      const fallbacks = handlers.filter((h) => eids.includes(h.id) && h.enabled && (h.response_template ?? "").trim() && h.action_type !== "ignore").slice(0, 6);
      for (const h of fallbacks) lines.push(`  - Fallback — if ${h.description?.trim() || h.name}: ${markIfCoveredHandler(renderLine(h), h, obs)}`);
      lines.push(`  - If truly NOTHING fits: bridge with ONE short, neutral sentence (invent nothing, ask nothing).`);
    } else {
      lines.push(`  - If NOTHING above fits: bridge with ONE short, neutral sentence (invent nothing, ask nothing).`);
    }
    return `  Answer with the best-fitting line below (if several fit, blend them into ONE short reply):\n${lines.join("\n")}` + rider;
  }

  if (ct === "send_sms") {
    const h = node.scenario_id ? byId.get(node.scenario_id) : undefined;
    const line = h?.response_template?.trim() ? renderLine(h) : `say in your own words: "The text with the details is on its way."`;
    return `  Confirm the text message — ${line}. (The system truly sends the SMS; say it is on the way, never that it already arrived.)` + rider;
  }

  if (ct === "end") {
    const h = node.scenario_id ? byId.get(node.scenario_id) : undefined;
    const statementsTail = statements.length ? " " + statements.join(" ") : "";
    if (h?.delivery === "reword" && h?.response_template?.trim()) {
      return `  Deliver this goodbye in your own words — nothing else, no questions: "${h.response_template.trim()}${statementsTail}" — the system ends the call right after you say it.`;
    }
    return `  The system itself speaks the goodbye and ends the call — add NOTHING beyond at most one filler.`;
  }

  if (ct === "transfer") return `  The system announces the transfer and connects the call — add NOTHING beyond at most one filler.`;
  if (ct === "wait") return `  (the script simply listens here — respond with at most one filler and let the customer continue)`;
  return `  (the script advances behind the scenes — reply with at most one filler; your next instructions follow)`;
}

/** Compile the menu for "the flow now sits at `nodeId`": one path per
 *  outgoing connector, each describing what its target box wants said.
 *  Returns null when the node has no outgoing paths (terminal). */
export async function compileStageBriefing(graph: Graph, nodeId: string, handlers: ListenerHandler[], obs?: ObserverCtx): Promise<string | null> {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return null;
  // Silence paths ({kind:"timeout"}) are engine plumbing, not customer-reply
  // routes — the poll-driven silence advance walks them, so they never
  // belong in the model's menu.
  const outs = graph.edges.filter((e) => e.source_node_id === nodeId && ((e.condition ?? {}) as Cfg).kind !== "timeout");
  if (!outs.length) return null;
  const byId = new Map(handlers.map((h) => [h.id, h] as const));
  const ordered = [...outs.filter((e) => !isAnyEdge(e)), ...outs.filter(isAnyEdge)];
  const bullets: string[] = [];
  for (const e of ordered) {
    const target = resolveThroughDisabled(graph, e.target_node_id);
    if (!target) continue;
    const c = (e.condition ?? {}) as Cfg;
    const matcher = handlers.find((h) => h.intent_key === (c.value as string));
    const when = isAnyEdge(e)
      ? "For ANY other reply"
      : `When: ${matcher?.description?.trim() || matcher?.name || String(c.value ?? "the matching reply")}`;
    bullets.push(`• ${when} →\n${await targetSays(target, byId, handlers, obs)}`);
  }
  if (!bullets.length) return null;
  // The universal fallback: without it, a stage whose paths don't cover the
  // reply leaves the model empty-handed — live calls degenerated to "mhm"
  // stonewalling at sparse boxes (Wait especially).
  bullets.push(
    `• If the reply fits NONE of the paths above → answer it from [STANDING ANSWERS] if one fits and STAY at this step; if none fits, bridge with ONE short, neutral sentence (invent nothing, ask nothing) — the system moves the call along when it's time.`
  );
  return [
    `[CURRENT STAGE — "${node.label || "next step"}"]`,
    `This supersedes every earlier CURRENT STAGE section — it ALONE governs your next reply. Answer the customer's next turn through exactly one of these paths:`,
    bullets.join("\n"),
    `Stage rules: reply IMMEDIATELY — never wait in silence for anything; open with at most ONE approved filler; if the customer raised several points, blend the matching lines into ONE short reply; use ONLY the lines above (plus [STANDING ANSWERS] and approved fillers); where a line reads as an instruction to you ("Explain that…", "Mention…"), do what it says in the customer's language — never read instruction wording aloud; never invent facts, prices, offers, account activity or questions; NEVER re-answer ground you already covered — if the customer says they didn't hear you ("hello?", "are you there?"), give a ONE-SENTENCE recap of your last point, never the full line again; if you were interrupted mid-reply, resume with only the part you had not yet said — never restart; speak at a calm, unhurried pace in short sentences with a natural beat between thoughts — never rush to fit everything in.`,
  ].join("\n");
}

/** The observer pass. Mid-call arming goes through here instead of the raw
 *  compiler: the observer knows the whole script AND the whole conversation,
 *  so every outgoing briefing gets reconciled against what was actually
 *  said — menu lines already delivered are MARKED (never removed: a wrong
 *  mark degrades to a rephrase, not a missing answer), and authored
 *  statements the customer never heard (skipped by racing or interruptions)
 *  come back as explicit debts. Best-effort: with no history it compiles
 *  exactly like the raw briefing. */
export async function composeArmedBriefing(
  callId: string,
  graph: Graph,
  targetId: string,
  handlers: ListenerHandler[]
): Promise<{ text: string; covered: number; owed: number } | null> {
  let corpus = "";
  let visited: string[] = [];
  let delivered: { handler_id: string; count: number }[] = [];
  try {
    [corpus, visited, delivered] = await Promise.all([
      agentSaidCorpus(callId),
      visitedFlowNodeIds(callId),
      getDeliveredHandlers(callId),
    ]);
  } catch {
    /* no history → plain briefing */
  }
  const corpusStems = new Set(stemsOf(corpus));
  // Fact-level coverage (VOZ-177) + interruption resilience (VOZ-178). A fact is
  // "conveyed" once ANY handler carrying its tag is either detected in the spoken
  // corpus (stem overlap) OR present in the delivered ledger. The ledger arm is
  // the interruption-resilient one: a barge-in truncates the transcript so the
  // spoken corpus misses the line, but the engine still recorded that it pushed
  // it — without this the observer re-serves the line and the agent repeats it,
  // exactly what happened when the Val call was talked over.
  const deliveredIds = new Set(delivered.map((d) => d.handler_id));
  const coveredFacts = new Set<string>();
  for (const h of handlers) {
    const facts = factsOf(h);
    if (!facts.length) continue;
    if (deliveredIds.has(h.id) || contentCovered(h.response_template, corpusStems)) {
      for (const f of facts) coveredFacts.add(f);
    }
  }
  const obs: ObserverCtx = { corpusStems, counter: { covered: 0 }, coveredFacts };
  const briefing = await compileStageBriefing(graph, targetId, handlers, obs);
  if (!briefing) return null;
  // Debts: statements of boxes the flow already passed through whose content
  // never made it into the agent's actual speech.
  const debts: string[] = [];
  for (const nid of visited) {
    if (nid === targetId) continue;
    const n = graph.nodes.find((x) => x.id === nid);
    if (!n) continue;
    for (const s of (((cfgOf(n).statements as string[]) ?? []).map((x) => (x ?? "").trim()).filter(Boolean))) {
      if (!contentCovered(s, obs.corpusStems) && !debts.includes(s)) debts.push(s);
    }
  }
  const owed = debts.slice(0, 2);
  const text = owed.length
    ? briefing +
      `\nStill OWED from earlier stages — the customer never actually heard these; work each into your NEXT reply naturally, once (own words where it reads as an instruction): ${owed
        .map((s, i) => `(${i + 1}) "${s}"`)
        .join(" ")}`
    : briefing;
  return { text, covered: obs.counter!.covered, owed: owed.length };
}

/** Off-path answer bank for the whole call: every collection the script's
 *  boxes reference, flattened. The reactive Playbook layer used to answer
 *  off-script questions while the flow parked; in brief-ahead the model owns
 *  the turn, so the same safety net must live in its prompt. */
export async function compileStandingAnswers(graph: Graph, handlers: ListenerHandler[]): Promise<string | null> {
  const colIds = new Set<string>();
  for (const n of graph.nodes) {
    const cfg = cfgOf(n);
    if (cfg.collectionId) colIds.add(cfg.collectionId as string);
    if (cfg.elseCollectionId) colIds.add(cfg.elseCollectionId as string);
  }
  if (!colIds.size) return null;
  const memberIds = new Set<string>();
  for (const cid of colIds) {
    for (const hid of await getCollectionHandlerIds(cid).catch(() => [] as string[])) memberIds.add(hid);
  }
  const members = handlers.filter((h) => memberIds.has(h.id) && h.enabled && (h.response_template ?? "").trim() && h.action_type !== "ignore").slice(0, 18);
  if (!members.length) return null;
  return [
    `[STANDING ANSWERS] Off-path questions and concerns the customer may raise at ANY point in the call. Use one ONLY when the CURRENT STAGE has no fitting path: answer briefly, then return to where the call was — never advance the plan on your own, and never re-answer one you already covered.`,
    ...members.map((h) => `- If ${h.description?.trim() || h.name}: ${renderLine(h)}`),
  ].join("\n");
}
