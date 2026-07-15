// Data access for the Listener Lab (organizer handlers, lab settings, call events).
// Same style as lib/db.ts; the supabase client is isomorphic so the webhook route
// can use these server-side too.
import { supabase } from "./client";
import type {
  ListenerHandler,
  LabCallEvent,
  LabSettings,
  ListenerCollection,
  ListenerScript,
  ListenerScriptNode,
  ListenerScriptEdge,
  Database,
} from "./database.types";

type HandlerInsert = Database["public"]["Tables"]["listener_handlers"]["Insert"];
type HandlerUpdate = Database["public"]["Tables"]["listener_handlers"]["Update"];
type EventInsert = Database["public"]["Tables"]["lab_call_events"]["Insert"];
type SettingsUpdate = Database["public"]["Tables"]["lab_settings"]["Update"];

// ── Handlers (Organizer) ──────────────────────────────────────

export async function listHandlers(): Promise<ListenerHandler[]> {
  const { data, error } = await supabase
    .from("listener_handlers")
    .select("*")
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createHandler(h: HandlerInsert): Promise<ListenerHandler> {
  const { data, error } = await supabase
    .from("listener_handlers")
    .insert(h)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateHandler(id: string, updates: HandlerUpdate): Promise<void> {
  const { error } = await supabase
    .from("listener_handlers")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteHandler(id: string): Promise<void> {
  const { error } = await supabase.from("listener_handlers").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Rename a group across every handler that uses it. */
export async function renameGroup(oldName: string, newName: string): Promise<void> {
  const { error } = await supabase
    .from("listener_handlers")
    .update({ group_name: newName, updated_at: new Date().toISOString() })
    .eq("group_name", oldName);
  if (error) throw new Error(error.message);
}

/** Remove a group — handlers stay but become ungrouped. */
export async function clearGroup(name: string): Promise<void> {
  const { error } = await supabase
    .from("listener_handlers")
    .update({ group_name: "", updated_at: new Date().toISOString() })
    .eq("group_name", name);
  if (error) throw new Error(error.message);
}

// ── Collections (campaign bundles) ────────────────────────────

export async function listCollections(): Promise<ListenerCollection[]> {
  const { data, error } = await supabase
    .from("listener_collections")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createCollection(name: string, description = ""): Promise<ListenerCollection> {
  const { data, error } = await supabase
    .from("listener_collections")
    .insert({ name, description })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCollection(
  id: string,
  updates: { name?: string; description?: string }
): Promise<void> {
  const { error } = await supabase
    .from("listener_collections")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteCollection(id: string): Promise<void> {
  const { error } = await supabase.from("listener_collections").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Handler IDs that belong to a collection. */
export async function getCollectionHandlerIds(collectionId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("listener_collection_handlers")
    .select("handler_id")
    .eq("collection_id", collectionId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.handler_id);
}

/** Replace a collection's membership with the given handler IDs. */
export async function setCollectionHandlers(collectionId: string, handlerIds: string[]): Promise<void> {
  const del = await supabase
    .from("listener_collection_handlers")
    .delete()
    .eq("collection_id", collectionId);
  if (del.error) throw new Error(del.error.message);
  if (handlerIds.length === 0) return;
  const rows = handlerIds.map((handler_id) => ({ collection_id: collectionId, handler_id }));
  const ins = await supabase.from("listener_collection_handlers").insert(rows);
  if (ins.error) throw new Error(ins.error.message);
}

// ── Scripts (visual call-flow builder) ────────────────────────

export async function listScripts(): Promise<ListenerScript[]> {
  const { data, error } = await supabase
    .from("listener_scripts")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createScript(name: string, collectionId: string | null = null): Promise<ListenerScript> {
  const { data, error } = await supabase
    .from("listener_scripts")
    .insert({ name, collection_id: collectionId })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateScript(
  id: string,
  updates: { name?: string; description?: string; collection_id?: string | null }
): Promise<void> {
  const { error } = await supabase
    .from("listener_scripts")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

export async function deleteScript(id: string): Promise<void> {
  const { error } = await supabase.from("listener_scripts").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Deep-copy a workflow: new script row + every node and arrow, with fresh
 *  ids and arrows remapped to the copied boxes. Node configs (connectors,
 *  statements, collection links) copy verbatim — connector handle ids only
 *  need to be unique within one script, and Playbook scenarios are shared
 *  by reference, not cloned. Returns the new script. */
export async function duplicateScript(id: string, newName: string): Promise<ListenerScript> {
  const [{ data: src, error: srcErr }, graph] = await Promise.all([
    supabase.from("listener_scripts").select("*").eq("id", id).single(),
    getScriptGraph(id),
  ]);
  if (srcErr) throw new Error(srcErr.message);
  const { data: copy, error: insErr } = await supabase
    .from("listener_scripts")
    .insert({ name: newName, description: src?.description ?? null, collection_id: src?.collection_id ?? null })
    .select()
    .single();
  if (insErr) throw new Error(insErr.message);
  const nodeIdMap = new Map(graph.nodes.map((n) => [n.id, crypto.randomUUID()] as const));
  if (graph.nodes.length) {
    const { error } = await supabase.from("listener_script_nodes").insert(
      graph.nodes.map((n) => ({
        id: nodeIdMap.get(n.id)!,
        script_id: copy.id,
        type: n.type,
        label: n.label,
        config: n.config,
        scenario_id: n.scenario_id,
        pos_x: n.pos_x,
        pos_y: n.pos_y,
      }))
    );
    if (error) throw new Error(error.message);
  }
  const edges = graph.edges.filter((e) => nodeIdMap.has(e.source_node_id) && nodeIdMap.has(e.target_node_id));
  if (edges.length) {
    const { error } = await supabase.from("listener_script_edges").insert(
      edges.map((e) => ({
        id: crypto.randomUUID(),
        script_id: copy.id,
        source_node_id: nodeIdMap.get(e.source_node_id)!,
        target_node_id: nodeIdMap.get(e.target_node_id)!,
        condition: e.condition,
        label: e.label,
      }))
    );
    if (error) throw new Error(error.message);
  }
  return copy;
}

export type ScriptGraph = { nodes: ListenerScriptNode[]; edges: ListenerScriptEdge[] };

export async function getScriptGraph(scriptId: string): Promise<ScriptGraph> {
  const [nodesRes, edgesRes] = await Promise.all([
    supabase.from("listener_script_nodes").select("*").eq("script_id", scriptId),
    supabase.from("listener_script_edges").select("*").eq("script_id", scriptId),
  ]);
  if (nodesRes.error) throw new Error(nodesRes.error.message);
  if (edgesRes.error) throw new Error(edgesRes.error.message);
  return { nodes: nodesRes.data ?? [], edges: edgesRes.data ?? [] };
}

type NodeInput = {
  id: string;
  type: string;
  scenario_id: string | null;
  label: string;
  config: Record<string, unknown>;
  pos_x: number;
  pos_y: number;
};
type EdgeInput = {
  id: string;
  source_node_id: string;
  target_node_id: string;
  condition: Record<string, unknown>;
  label: string;
};

/** Replace the whole graph for a script (upsert-then-prune — a save that
 *  fails mid-way must leave the stored graph intact; the old delete-then-
 *  insert wiped every edge whenever one row was rejected). */
export async function saveScriptGraph(
  scriptId: string,
  nodes: NodeInput[],
  edges: EdgeInput[]
): Promise<void> {
  // Nodes before edges (edges reference nodes).
  if (nodes.length) {
    const ni = await supabase
      .from("listener_script_nodes")
      .upsert(nodes.map((n) => ({ ...n, script_id: scriptId })));
    if (ni.error) throw new Error(ni.error.message);
  }
  if (edges.length) {
    const ei = await supabase
      .from("listener_script_edges")
      .upsert(edges.map((e) => ({ ...e, script_id: scriptId })));
    if (ei.error) throw new Error(ei.error.message);
  }
  // Prune rows dropped from the graph — edges first (FK to nodes).
  let de = supabase.from("listener_script_edges").delete().eq("script_id", scriptId);
  if (edges.length) de = de.not("id", "in", `(${edges.map((e) => e.id).join(",")})`);
  const der = await de;
  if (der.error) throw new Error(der.error.message);
  let dn = supabase.from("listener_script_nodes").delete().eq("script_id", scriptId);
  if (nodes.length) dn = dn.not("id", "in", `(${nodes.map((n) => n.id).join(",")})`);
  const dnr = await dn;
  if (dnr.error) throw new Error(dnr.error.message);
  await supabase
    .from("listener_scripts")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", scriptId);
}

// ── Settings ──────────────────────────────────────────────────

export async function getLabSettings(): Promise<LabSettings | null> {
  const { data, error } = await supabase
    .from("lab_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function saveLabSettings(updates: SettingsUpdate): Promise<void> {
  const { error } = await supabase
    .from("lab_settings")
    .upsert({ id: "default", ...updates, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

// ── Flow state (runtime graph-walker) ─────────────────────────

export async function getFlowState(callId: string) {
  const { data, error } = await supabase
    .from("lab_call_flow_state")
    .select("*")
    .eq("call_id", callId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function upsertFlowState(
  callId: string,
  scriptId: string | null,
  currentNodeId: string | null,
  variables: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("lab_call_flow_state").upsert({
    call_id: callId,
    script_id: scriptId,
    current_node_id: currentNodeId,
    variables,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Persist flow state only if nobody advanced it since we read it (optimistic
 *  lock on updated_at). Split final transcripts arrive as concurrent webhook
 *  invocations — without this, both walk the flow from the same position and
 *  the customer hears the same step twice. Returns false on a lost race. */
export async function persistFlowStateGuarded(
  callId: string,
  scriptId: string | null,
  currentNodeId: string | null,
  variables: Record<string, unknown>,
  expectedUpdatedAt: string | null
): Promise<boolean> {
  const row = {
    script_id: scriptId,
    current_node_id: currentNodeId,
    variables,
    updated_at: new Date().toISOString(),
  };
  if (expectedUpdatedAt) {
    const { data, error } = await supabase
      .from("lab_call_flow_state")
      .update(row)
      .eq("call_id", callId)
      .eq("updated_at", expectedUpdatedAt)
      .select("call_id");
    if (error) throw new Error(error.message);
    return (data ?? []).length > 0;
  }
  const { error } = await supabase.from("lab_call_flow_state").insert({ call_id: callId, ...row });
  if (error) {
    if (error.code === "23505") return false; // concurrent first turn won
    throw new Error(error.message);
  }
  return true;
}

// ── Call events ───────────────────────────────────────────────

export async function insertLabEvent(event: EventInsert): Promise<void> {
  const { error } = await supabase.from("lab_call_events").insert(event);
  if (error) throw new Error(error.message);
}

export async function insertLabEventReturningId(event: EventInsert): Promise<number | null> {
  const { data, error } = await supabase.from("lab_call_events").insert(event).select("id").single();
  if (error) throw new Error(error.message);
  return (data?.id as number) ?? null;
}

/** Has the agent already spoken (or STARTED speaking) since this customer
 *  utterance? Injections land seconds after the agent's own natural reply —
 *  when it has, the line must CONTINUE the reply (no re-acknowledging, no
 *  re-asking), never start a second one. Transcripts lag until a sentence
 *  finishes, so Vapi's real-time speech-started events count too — that lag
 *  once produced "Right. It's Tom from— Right. It's Tom with Lucky Seven". */
export async function agentSpokeSince(callId: string, afterId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("event_type, content")
    .eq("call_id", callId)
    .gt("id", afterId)
    .in("event_type", ["agent_said", "status"])
    .limit(25);
  if (error) throw new Error(error.message);
  return (data ?? []).some(
    (e) =>
      e.event_type === "agent_said" ||
      (e.content ?? "").startsWith("speech-update: started (assistant")
  );
}

/** The agent's actual spoken words since this utterance (joined fragments,
 *  most recent tail). Quoted back in continuation briefings — showing the
 *  model what it already said beats telling it "don't repeat yourself"
 *  ("This is Tom with Lucky's. I'm Tom with Lucky Seven, and…"). */
export async function agentWordsSince(callId: string, afterId: number): Promise<string | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("content")
    .eq("call_id", callId)
    .eq("event_type", "agent_said")
    .gt("id", afterId)
    .order("id", { ascending: true })
    .limit(10);
  if (error) throw new Error(error.message);
  const joined = (data ?? [])
    .map((e) => (e.content ?? "").trim())
    .filter(Boolean)
    .join(" ");
  if (!joined) return null;
  return joined.length > 220 ? "…" + joined.slice(-220) : joined;
}

/** The immediately-previous customer fragment, if it's recent and unanswered.
 *  Split finals ("who is this again?" + "what is this about?") are ONE
 *  customer turn — the newest fragment folds the previous one in before
 *  classification so multi-part merging works across fragments. */
export async function recentUnansweredFragment(
  callId: string,
  beforeId: number,
  withinMs: number
): Promise<string | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("id, content, utterance_at")
    .eq("call_id", callId)
    .eq("event_type", "utterance")
    .lt("id", beforeId)
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const prev = (data ?? [])[0];
  if (!prev?.utterance_at) return null;
  if (Date.now() - new Date(prev.utterance_at).getTime() > withinMs) return null;
  // If anything was already injected after it, that turn is answered — done.
  const { data: inj, error: e2 } = await supabase
    .from("lab_call_events")
    .select("id")
    .eq("call_id", callId)
    .eq("event_type", "injected")
    .gt("id", prev.id)
    .limit(1);
  if (e2) throw new Error(e2.message);
  if ((inj ?? []).length > 0) return null;
  return (prev.content ?? "").trim() || null;
}

/** Recent runs (calls) of a script, newest first — the builder's run history.
 *  Every call that walked this script has a flow-state row, whether it was
 *  started from the builder, the Lab, or production. */
export async function listScriptRuns(
  scriptId: string,
  limit = 20
): Promise<{ call_id: string; current_node_id: string | null; updated_at: string }[]> {
  const { data, error } = await supabase
    .from("lab_call_flow_state")
    .select("call_id, current_node_id, updated_at")
    .eq("script_id", scriptId)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as { call_id: string; current_node_id: string | null; updated_at: string }[];
}

/** Customer-turn counts for a batch of calls — powers the run-history list
 *  ("N turns") without one query per run. */
export async function utteranceCounts(callIds: string[]): Promise<Record<string, number>> {
  if (!callIds.length) return {};
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("call_id")
    .in("call_id", callIds)
    .eq("event_type", "utterance")
    .limit(2000);
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.call_id] = (counts[r.call_id] ?? 0) + 1;
  return counts;
}

/** The call's memory of what has already been SAID: how many times each
 *  scenario was delivered so far (anti-repeat ledger). Insertion order =
 *  delivery order, so the first topics covered come first. */
export async function getDeliveredHandlers(callId: string): Promise<{ handler_id: string; count: number }[]> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("handler_id")
    .eq("call_id", callId)
    .eq("event_type", "injected")
    .not("handler_id", "is", null)
    .limit(300);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const r of data ?? []) counts.set(r.handler_id as string, (counts.get(r.handler_id as string) ?? 0) + 1);
  return [...counts].map(([handler_id, count]) => ({ handler_id, count }));
}

/** A persisted speculative classification for exactly this text, if fresh.
 *  The in-memory speculation map dies at the serverless instance boundary —
 *  the partial and the final rarely land on the same instance — so speculate()
 *  also stores its result as a `speculated` event and the final's handler
 *  reads it back here. */
export async function getSpeculated(
  callId: string,
  text: string,
  withinMs: number
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("meta, created_at")
    .eq("call_id", callId)
    .eq("event_type", "speculated")
    .eq("content", text)
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0];
  if (!row?.created_at || Date.now() - new Date(row.created_at).getTime() > withinMs) return null;
  const cls = (row.meta as Record<string, unknown> | null)?.cls;
  return (cls as Record<string, unknown> | undefined) ?? null;
}

/** Newest event id for a call — a clock-free anchor for "did X happen after
 *  this point" checks (server and DB clocks drift; row ids never lie). */
export async function latestEventId(callId: string): Promise<number> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("id")
    .eq("call_id", callId)
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? [])[0]?.id ?? 0;
}

/** Did the agent say something SUBSTANTIAL after this anchor? Powers the
 *  delivery watchdog: a triggered briefing can race the agent's own filler
 *  ("Perfect.") and get swallowed — a short filler must not count as the
 *  line having been voiced, so a minimum length filters it out. */
export async function agentSaidAfter(callId: string, afterId: number, minLen = 0, exclude: string[] = []): Promise<boolean> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("content")
    .eq("call_id", callId)
    .eq("event_type", "agent_said")
    .gt("id", afterId)
    .limit(25);
  if (error) throw new Error(error.message);
  // Excluded lines (the configured idle nudges) compare punctuation-blind:
  // the transcriber may render "time — I'm" as "time. I'm".
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const ex = new Set(exclude.map(norm));
  return (data ?? []).some((e) => {
    const t = (e.content ?? "").trim();
    return t.length >= minLen && !ex.has(norm(t));
  });
}

/** Everything the agent has actually said this call, as one lowercase blob —
 *  the observer pass compares outgoing briefings against it to mark covered
 *  ground and detect owed content. */
export async function agentSaidCorpus(callId: string): Promise<string> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("content")
    .eq("call_id", callId)
    .eq("event_type", "agent_said")
    .order("id", { ascending: false })
    .limit(60);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.content ?? "").join(" ").toLowerCase();
}

/** The boxes this call's flow has actually visited (model_side turns), in
 *  order — the observer walks their statements to find un-voiced debts. */
export async function visitedFlowNodeIds(callId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("meta")
    .eq("call_id", callId)
    .eq("event_type", "injected")
    .order("id", { ascending: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const out: string[] = [];
  for (const r of data ?? []) {
    const m = (r.meta ?? {}) as Record<string, unknown>;
    if (m.flow && m.mode === "model_side" && typeof m.toNode === "string" && !out.includes(m.toNode)) out.push(m.toNode);
  }
  return out;
}

/** When did the assistant last STOP speaking? Null if its newest speech
 *  transition is a start (still talking) or it never spoke. Powers the
 *  interruption arbiter: a stop moments before a noise utterance means the
 *  noise cut the agent off mid-line — grounds for a resume nudge. */
export async function lastAssistantSpeechStop(callId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("content, created_at")
    .eq("call_id", callId)
    .eq("event_type", "status")
    .like("content", "speech-update:%(assistant)")
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const r = (data ?? [])[0];
  if (!r || !(r.content ?? "").startsWith("speech-update: stopped")) return null;
  return new Date(r.created_at).getTime();
}

/** When did ANYONE last speak on this call (customer utterance or agent
 *  transcript)? Excluded lines (the configured idle nudges) don't count —
 *  they'd reset the Wait box's silence clock every 12s and the timeout
 *  would never fire. Returns epoch ms, or null for a call with no speech. */
export async function lastSpeechAt(callId: string, exclude: string[] = []): Promise<number | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("event_type, content, created_at")
    .eq("call_id", callId)
    .in("event_type", ["utterance", "agent_said"])
    .order("id", { ascending: false })
    .limit(25);
  if (error) throw new Error(error.message);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const ex = new Set(exclude.map(norm));
  for (const e of data ?? []) {
    if (e.event_type === "agent_said" && ex.has(norm((e.content ?? "").trim()))) continue;
    return new Date(e.created_at).getTime();
  }
  return null;
}

/** The newest flow injection for a call — the delivery watchdog's subject. */
export async function lastFlowInjection(
  callId: string
): Promise<{ id: number; content: string; createdAt: string; meta: Record<string, unknown> } | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("id, content, created_at, meta")
    .eq("call_id", callId)
    .eq("event_type", "injected")
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const r = (data ?? [])[0];
  if (!r) return null;
  return { id: r.id, content: r.content ?? "", createdAt: r.created_at, meta: (r.meta ?? {}) as Record<string, unknown> };
}

/** Watchdog bookkeeping since an injection: was the blunt retrigger already
 *  sent, and was the undelivered error already raised? Persisted as events so
 *  the check stays idempotent across serverless invocations. */
export async function watchdogStateAfter(
  callId: string,
  afterId: number
): Promise<{ retriggerAt: string | null; errored: boolean }> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("event_type, created_at, meta")
    .eq("call_id", callId)
    .gt("id", afterId)
    .in("event_type", ["skipped", "error"])
    .limit(25);
  if (error) throw new Error(error.message);
  let retriggerAt: string | null = null;
  let errored = false;
  for (const e of data ?? []) {
    const reason = (e.meta as Record<string, unknown> | null)?.reason;
    if (e.event_type === "skipped" && reason === "retrigger") retriggerAt = e.created_at;
    if (e.event_type === "error" && reason === "undelivered") errored = true;
  }
  return { retriggerAt, errored };
}

/** Is the assistant speaking RIGHT NOW? True when its latest speech-update
 *  status event is a "started" without a later "stopped". Powers the speaking
 *  lock: a response-triggering injection over a mid-sentence agent produces
 *  the overlapping double-intro. */
export async function assistantSpeaking(callId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("content")
    .eq("call_id", callId)
    .eq("event_type", "status")
    .like("content", "speech-update:%(assistant)")
    .order("id", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data ?? [])[0]?.content ?? "").startsWith("speech-update: started");
}

/** Did a newer customer utterance arrive after this one? Split final
 *  transcripts land as separate turns ~1s apart — only the newest deserves a
 *  response; earlier fragments are stale. */
export async function hasNewerUtterance(callId: string, afterId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("id")
    .eq("call_id", callId)
    .eq("event_type", "utterance")
    .gt("id", afterId)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function listLabCallEvents(callId: string, afterId = 0): Promise<LabCallEvent[]> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("*")
    .eq("call_id", callId)
    .gt("id", afterId)
    .order("id", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Recent conversation turns for a call, oldest-first, as "Customer:/Agent:" lines.
 *  Gives the router LLM context so a keyword can't hijack the intent.
 *  agent_said events are the agent's ACTUAL spoken words (from assistant
 *  transcripts) — crucial so "okay, sure" right after "want me to text it?"
 *  reads as consent, not noise. */
export async function getRecentTurns(callId: string, limit = 6): Promise<string[]> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("event_type, content")
    .eq("call_id", callId)
    .in("event_type", ["utterance", "injected", "agent_said"])
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .reverse()
    .map((e) => (e.event_type === "utterance" ? "Customer: " : "Agent: ") + (e.content ?? ""));
}

export async function getLastInjectedEvent(callId: string): Promise<LabCallEvent | null> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("*")
    .eq("call_id", callId)
    .eq("event_type", "injected")
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** Recent events across calls, for grouping into "past runs" client-side. */
export async function listRecentLabEvents(limit = 1000): Promise<LabCallEvent[]> {
  const { data, error } = await supabase
    .from("lab_call_events")
    .select("*")
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data ?? [];
}
