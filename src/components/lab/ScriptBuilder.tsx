"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  useUpdateNodeInternals,
  BaseEdge,
  EdgeLabelRenderer,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type EdgeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  listScripts,
  duplicateScript,
  updateScript,
  deleteScript,
  getScriptGraph,
  saveScriptGraph,
  listHandlers,
  createHandler,
  updateHandler,
  listCollections,
  getCollectionHandlerIds,
  getLabSettings,
  saveLabSettings,
  getFlowState,
  listLabCallEvents,
  listScriptRuns,
  utteranceCounts,
  insertLabEvent,
} from "@/lib/scriptEngine/lab-db-client";
import { getVapi, vapiErrorText } from "@/lib/scriptEngine/vapi";
import LabConfigForm from "@/components/lab/LabConfigForm";
import type { ListenerScript, ListenerHandler, ListenerCollection, LabCallEvent } from "@/lib/scriptEngine/database.types";
import { CONTENT_META, metaOf, type Content } from "./scriptContent";

// Content types + CONTENT_META + metaOf live in ./scriptContent (a pure module,
// no React/DOM — so the runtime and vitest can read them without the canvas deps).

type Kind = "start" | "step";

type NodeData = {
  kind: Kind;
  label: string;
  scenarioId: string | null;
  config: Record<string, unknown>;
  // display helpers (not persisted directly)
  subtitle?: string | null;
  note?: string | null;
  // live-run marker: where the current test call is / has been
  runState?: "current" | "visited" | null;
};

const snip = (t: string, n: number) => {
  const s = t.trim().replace(/\s+/g, " ");
  return s.length > n ? s.slice(0, n) + "…" : s;
};

// A reply connector: an extra output dot on a box whose arrow fires when the
// customer's reply matches the picked scenario — or, with `any`, on ANY reply
// the other connectors didn't claim ("anything other than yes", "after this
// box continue no matter what"). Ids are "c:<uuid>" so they're
// distinguishable from the fixed handles (out/then/else/loop/exit) everywhere.
type Connector = { id: string; intentKey: string; label?: string; any?: boolean; silence?: boolean; quickWords?: string };
const isConnectorHandle = (h: string | null | undefined): h is string => !!h && h.startsWith("c:");
const connectorsOf = (config: Record<string, unknown>): Connector[] =>
  Array.isArray(config.connectors) ? (config.connectors as Connector[]) : [];

// Source handles a box exposes (id used as edge.sourceHandle for routing).
function sourceHandlesFor(
  isStart: boolean,
  content: Content,
  connectors: Connector[]
): { id: string; label?: string; color?: string }[] {
  // No default path: reply connectors are the ONLY outputs. (Legacy plain
  // arrows still render via a hidden anchor on the box — see FlowNode.)
  const conns = connectors.map((c) => ({
    id: c.id,
    label: c.silence ? "stays silent" : c.any ? "anything else" : c.label ? snip(c.label, 13) : undefined,
    color: c.silence ? "#38bdf8" : "#34d399",
  }));
  if (isStart) return conns;
  if (metaOf(content).terminal) return [];
  return conns;
}

// ── Custom node ───────────────────────────────────────────────
// The canvas node lives outside the component tree that owns state, so the
// "+ connector" click is routed through this module-scope holder.
const addConnectorRef: { fn: (nodeId: string) => void } = { fn: () => {} };
// Hover-toolbar actions (duplicate / toggle active / delete), same pattern.
const nodeActionRef: { fn: (nodeId: string, action: "duplicate" | "toggle" | "delete") => void } = { fn: () => {} };

function FlowNode({ id, data, selected }: NodeProps) {
  const d = data as NodeData;
  const isStart = d.kind === "start";
  const content = (d.config.contentType as Content) ?? "scenario";
  const meta = isStart ? { label: "Start call", color: "border-emerald-500 bg-emerald-500/10" } : metaOf(content);
  const handles = sourceHandlesFor(isStart, content, connectorsOf(d.config));
  const labelled = handles.some((h) => h.label);
  const canAddConnector = isStart || !metaOf(content).terminal;
  // React Flow caches each node's handle layout — without this, a dot added
  // to an already-wired box isn't connectable and existing arrows keep
  // anchoring to the old positions.
  const updateNodeInternals = useUpdateNodeInternals();
  const handleKey = handles.map((h) => `${h.id}:${h.label ?? ""}`).join("|");
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, handleKey, updateNodeInternals]);
  const ring =
    d.runState === "current"
      ? "ring-4 ring-emerald-400 shadow-[0_0_22px_rgba(52,211,153,0.65)]"
      : d.runState === "visited"
        ? "ring-2 ring-emerald-500 shadow-[0_0_10px_rgba(52,211,153,0.35)]"
        : selected
          ? "ring-2 ring-white/60"
          : "";
  const nodeDisabled = d.config.disabled === true;
  // Additional statements are parasites: they exist only through a host box
  // and ride along with its reply — drawn as dashed capsules latched onto the
  // box's left side. Clicking one selects the host (that's where they live).
  const stmts = ((d.config.statements as string[]) ?? []).map((s) => (s ?? "").trim()).filter(Boolean);
  return (
    <div
      className={`group max-w-[420px] rounded-lg border-2 px-3 ${labelled ? "pb-7 pt-2" : "py-2"} text-left shadow ${meta.color} ${ring} ${nodeDisabled ? "opacity-50" : ""}`}
      style={{ minWidth: Math.max(160, handles.length * 64) }}
    >
      {/* Hover toolbar: duplicate / activate-deactivate / delete */}
      <div className="pointer-events-none absolute -top-3.5 right-1 z-10 hidden gap-1 group-hover:flex">
        {!isStart && (
          <button
            title="Duplicate this box"
            onClick={(e) => {
              e.stopPropagation();
              nodeActionRef.fn(id, "duplicate");
            }}
            className="nodrag nopan pointer-events-auto flex h-5 w-5 items-center justify-center rounded border border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        )}
        {!isStart && (
          <button
            title={nodeDisabled ? "Activate this box" : "Deactivate — the call passes through it without speaking"}
            onClick={(e) => {
              e.stopPropagation();
              nodeActionRef.fn(id, "toggle");
            }}
            className={`nodrag nopan pointer-events-auto flex h-5 w-5 items-center justify-center rounded border bg-gray-800 hover:bg-gray-700 ${
              nodeDisabled ? "border-amber-500/60 text-amber-300" : "border-gray-600 text-gray-300 hover:text-white"
            }`}
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </button>
        )}
        <button
          title="Delete this box"
          onClick={(e) => {
            e.stopPropagation();
            nodeActionRef.fn(id, "delete");
          }}
          className="nodrag nopan pointer-events-auto flex h-5 w-5 items-center justify-center rounded border border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-rose-400"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
      {!isStart && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ width: 13, height: 13, top: 4, background: "#94a3b8", border: "2px solid #0f172a" }}
        />
      )}
      <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-gray-300">
        {meta.label}
        {nodeDisabled && <span className="rounded-full bg-gray-700 px-1.5 py-px text-[9px] font-semibold normal-case text-gray-400">inactive</span>}
      </p>
      <p className="truncate text-sm font-medium text-white">{d.label || meta.label}</p>
      {d.subtitle && <p className="mt-0.5 truncate text-[11px] text-gray-400">{d.subtitle}</p>}
      {d.note && <p className="mt-0.5 line-clamp-2 text-[10px] italic text-gray-500">{d.note}</p>}
      {handles.map((h, i) => {
        const left = `${((i + 1) / (handles.length + 1)) * 100}%`;
        return (
          <span key={h.id}>
            <Handle
              id={h.id}
              type="source"
              position={Position.Bottom}
              style={{ left, width: 13, height: 13, bottom: 4, background: h.color ?? "#34d399", border: "2px solid #0f172a" }}
            />
            {h.label && (
              <span
                className={`absolute bottom-[18px] max-w-[72px] -translate-x-1/2 truncate text-[8px] font-semibold text-gray-300 ${
                  selected || d.runState === "current" ? "" : "hidden group-hover:block"
                }`}
                style={{ left }}
              >
                {h.label}
              </span>
            )}
          </span>
        );
      })}
      {/* Parasite statements — always spoken with this box's reply */}
      {stmts.length > 0 && (
        <div className="absolute right-full top-1.5 mr-0 w-44 space-y-1">
          {stmts.map((s, i) => (
            <div key={i} className="flex items-center justify-end" title={s}>
              <span className="max-w-full truncate rounded-full border border-dashed border-gray-500 bg-gray-800/95 px-2 py-0.5 text-[9px] leading-tight text-gray-300">
                + {snip(s, 34)}
              </span>
              <span className="h-px w-2.5 shrink-0 bg-gray-500" />
            </div>
          ))}
        </div>
      )}
      {canAddConnector && (
        <>
          {/* Hidden anchor: legacy plain arrows (old scripts' default paths)
              still render from here, but no new one can be started. */}
          <Handle
            id="out"
            type="source"
            position={Position.Bottom}
            isConnectableStart={false}
            style={{ left: "50%", width: 1, height: 1, minWidth: 1, minHeight: 1, bottom: 0, opacity: 0, pointerEvents: "none", border: "none" }}
          />
          <button
            className="nodrag nopan absolute -bottom-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full border border-gray-600 bg-gray-800 text-sm font-bold leading-none text-gray-300 shadow transition hover:border-emerald-400 hover:bg-gray-700 hover:text-emerald-300"
            title="Add a reply connector — a green dot for one predicted customer reply"
            onClick={(e) => {
              e.stopPropagation();
              addConnectorRef.fn(id);
            }}
          >
            +
          </button>
        </>
      )}
    </div>
  );
}
const nodeTypes = { lab: FlowNode };

// A connector arrow pointing back at its OWN box ("repeat this stage") —
// the default bezier between two near-identical points is an unreadable
// squiggle. Draw a proper loop instead: out of the bottom dot, around the
// right side of the box, back into the top, label at the apex.
function SelfLoopEdge({ id, sourceX, sourceY, targetX, targetY, style, markerEnd, label }: EdgeProps) {
  const reach = 110;
  const midY = (sourceY + targetY) / 2;
  const apexX = Math.max(sourceX, targetX) + reach;
  const path =
    `M ${sourceX} ${sourceY} ` +
    `C ${sourceX + reach * 0.6} ${sourceY + 55}, ${apexX} ${midY + 45}, ${apexX} ${midY} ` +
    `C ${apexX} ${midY - 45}, ${targetX + reach * 0.6} ${targetY - 55}, ${targetX} ${targetY}`;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label ? (
        <EdgeLabelRenderer>
          <div
            style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${apexX}px, ${midY}px)`, pointerEvents: "all" }}
            className="rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 text-[10px] font-medium text-gray-300"
          >
            {String(label)}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
const edgeTypes = { selfloop: SelfLoopEdge };

const inputCls =
  "w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none";

// ── Normalisation: map legacy node/edge shapes to the new model ──
function legacyToContent(type: string): Content | null {
  switch (type) {
    case "say":
    case "switch":
      return "scenario";
    case "send_sms":
      return "send_sms";
    case "transfer":
      return "transfer";
    case "end":
      return "end";
    case "set_variable":
      return "noop";
    default:
      return null;
  }
}



type Props = { onClose: () => void; initialScriptId?: string | null };

// Inline-authored line for a box — the scenario is created or updated in the
// Playbook automatically when the script is saved.
type LineDraft = { text: string; delivery: ListenerHandler["delivery"]; hint: string };

// Box types whose spoken line is authored inline.
const LINE_CONTENT: Content[] = ["scenario", "end", "send_sms", "transfer"];

export default function ScriptBuilder({ onClose, initialScriptId }: Props) {
  const [scripts, setScripts] = useState<ListenerScript[]>([]);
  const [scriptId, setScriptId] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<ListenerHandler[]>([]);
  const [collections, setCollections] = useState<ListenerCollection[]>([]);
  const [activeScriptId, setActiveScriptId] = useState<string | null>(null);
  // The VAPI assistant test calls dial — same setting the Listener Lab uses.
  const [labAssistantId, setLabAssistantId] = useState<string>("");
  // The full Lab configuration, opened via the cog into the right drawer.
  const [configOpen, setConfigOpen] = useState(false);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selNodeId, setSelNodeId] = useState<string | null>(null);
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null);
  const [rf, setRf] = useState<ReactFlowInstance<Node, Edge> | null>(null);

  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineDrafts, setLineDrafts] = useState<Record<string, LineDraft>>({});

  // ── Dirty tracking + undo/redo ──────────────────────────────
  // Every canvas mutation snapshots the graph first (coalesced for typing),
  // marks the script dirty (Save enables, leaving warns), and Ctrl+Z walks
  // back through up to 50 steps.
  const [dirty, setDirty] = useState(false);
  const undoStack = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const redoStack = useRef<Array<{ nodes: Node[]; edges: Edge[] }>>([]);
  const lastSnapAt = useRef(0);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  const cloneGraph = () => JSON.parse(JSON.stringify({ nodes: nodesRef.current, edges: edgesRef.current })) as { nodes: Node[]; edges: Edge[] };
  function snapshot(coalesceMs = 0) {
    setDirty(true);
    const now = Date.now();
    if (coalesceMs && now - lastSnapAt.current < coalesceMs) return;
    lastSnapAt.current = now;
    undoStack.current.push(cloneGraph());
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
  }
  function undo() {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(cloneGraph());
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setDirty(true);
  }
  function redo() {
    const nxt = redoStack.current.pop();
    if (!nxt) return;
    undoStack.current.push(cloneGraph());
    setNodes(nxt.nodes);
    setEdges(nxt.edges);
    setDirty(true);
  }
  function confirmDiscard(): boolean {
    return !dirty || window.confirm("You have unsaved changes. Discard them?");
  }
  // Drag moves snapshot once per drag, not per pixel.
  const dragSnapped = useRef(false);
  const handleNodesChange: typeof onNodesChange = (changes) => {
    const dragging = changes.some((c) => c.type === "position" && (c as { dragging?: boolean }).dragging === true);
    const dropped = changes.some((c) => c.type === "position" && (c as { dragging?: boolean }).dragging === false);
    if (dragging && !dragSnapped.current) {
      snapshot();
      dragSnapped.current = true;
    }
    if (dropped) dragSnapped.current = false;
    onNodesChange(changes);
  };
  // Keyboard: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, and Delete routed through OUR
  // delete (React Flow's default skips the draft cleanup).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selNodeId || selEdgeId) {
          e.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // Non-blocking issues found at save time.
  const [warnings, setWarnings] = useState<string[]>([]);

  // Keep the editable title in sync with the loaded script.
  useEffect(() => {
    setName(scripts.find((s) => s.id === scriptId)?.name ?? "");
  }, [scriptId, scripts]);

  async function handleRename() {
    const trimmed = name.trim();
    if (!scriptId || !trimmed || trimmed === scripts.find((s) => s.id === scriptId)?.name) return;
    try {
      await updateScript(scriptId, { name: trimmed });
      setScripts((ss) => ss.map((s) => (s.id === scriptId ? { ...s, name: trimmed } : s)));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  const allTags = useMemo(
    () => Array.from(new Set(scenarios.flatMap((s) => s.tags ?? []).filter(Boolean))).sort(),
    [scenarios]
  );

  const scenarioName = useCallback(
    (id: string | null) => (id ? scenarios.find((s) => s.id === id)?.name ?? null : null),
    [scenarios]
  );
  // Short preview of a scenario's line, for box subtitles on the canvas.
  const scenarioLine = useCallback(
    (id: string | null) => {
      if (!id) return null;
      const s = scenarios.find((x) => x.id === id);
      if (!s) return null;
      const t = (s.response_template || "").trim().replace(/\s+/g, " ");
      if (!t) return s.name;
      return t.length > 42 ? t.slice(0, 42) + "…" : t;
    },
    [scenarios]
  );
  const collectionName = useCallback(
    (id: string | undefined) => (id ? collections.find((c) => c.id === id)?.name ?? null : null),
    [collections]
  );
  const scriptName = useCallback(
    (id: string | undefined) => (id ? scripts.find((s) => s.id === id)?.name ?? null : null),
    [scripts]
  );

  function subtitleFor(d: NodeData): string | null {
    if (d.kind === "start") {
      if ((d.config.mode as string) === "wait_for_customer") return "waits for caller";
      const op = ((d.config.opening as string) ?? "").trim();
      return op ? `“${snip(op, 42)}”` : "agent opens";
    }
    const c = (d.config.contentType as Content) ?? "scenario";
    if (c === "scenario") return scenarioLine(d.scenarioId) ? `“${scenarioLine(d.scenarioId)}”` : "(click to write the line)";
    if (c === "collection") return collectionName(d.config.collectionId as string) ? `▣ ${collectionName(d.config.collectionId as string)}` : "(pick a collection)";
    if (c === "subworkflow") return scriptName(d.config.subworkflowId as string) ? `⤳ ${scriptName(d.config.subworkflowId as string)}` : "(pick a workflow)";
    if (c === "send_sms") return scenarioLine(d.scenarioId) ? `“${scenarioLine(d.scenarioId)}”` : "(click to write the confirmation)";
    if (c === "transfer") return (d.config.number as string) || "(phone number)";
    if (c === "return") return `↩ ${(d.config.resultName as string) || "result"}`;
    if (c === "wait") {
      const secs = Number(d.config.waitSeconds) || 8;
      const hasSilence = connectorsOf(d.config).some((x) => x.silence) || false;
      return hasSilence ? `listens — silent ${secs}s → silence path` : "listens for the caller's reply";
    }
    if (c === "end") return scenarioLine(d.scenarioId) ? `“${scenarioLine(d.scenarioId)}”` : null;
    return null;
  }

  // Scenario description shown on the box — says WHEN this line/branch fires.
  function noteFor(d: NodeData): string | null {
    if (d.kind !== "step") return null;
    const c = (d.config.contentType as Content) ?? "scenario";
    if (!LINE_CONTENT.includes(c)) return null;
    const s = d.scenarioId ? scenarios.find((x) => x.id === d.scenarioId) : undefined;
    const t = c === "transfer" ? (s?.response_template ?? "").trim() : (s?.description ?? "").trim();
    return t ? snip(t, 64) : null;
  }
  function annotate(d: NodeData): NodeData {
    d.subtitle = subtitleFor(d);
    d.note = noteFor(d);
    return d;
  }

  useEffect(() => {
    (async () => {
      try {
        const [scs, hs, cols, settings] = await Promise.all([
          listScripts(),
          listHandlers(),
          listCollections(),
          getLabSettings(),
        ]);
        setScripts(scs);
        setScenarios(hs);
        setCollections(cols);
        setActiveScriptId(settings?.active_script_id ?? null);
        setLabAssistantId(((settings as unknown as { lab_assistant_id?: string } | null)?.lab_assistant_id ?? "") as string);
        if (initialScriptId) loadScript(initialScriptId);
        else if (scs.length && !scriptId) loadScript(scs[0].id);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Failed to load — did you run the scripts migration?");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh node subtitles/notes when reference data loads.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: annotate({ ...(n.data as NodeData) }) })));
    // Connector-arrow labels come from scenario names, which may load after
    // the graph — refresh them too.
    setEdges((es) =>
      es.map((e) => {
        const c = (e.data as { condition?: Record<string, unknown> })?.condition;
        if (!isConnectorHandle(c?.handle as string) || !c?.value) return e;
        const scn = scenarios.find((s) => s.intent_key === c.value);
        return scn ? { ...e, label: snip(scn.name, 18) } : e;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios, collections, scripts]);

  function graphToFlow(g: Awaited<ReturnType<typeof getScriptGraph>>): { rfNodes: Node[]; rfEdges: Edge[] } {
    const rfNodes: Node[] = g.nodes.map((n) => {
      const isStart = n.type === "start";
      const cfg = (n.config ?? {}) as Record<string, unknown>;
      if (!isStart && !cfg.contentType) cfg.contentType = legacyToContent(n.type) ?? "scenario";
      const data: NodeData = { kind: isStart ? "start" : "step", label: n.label, scenarioId: n.scenario_id, config: cfg };
      annotate(data);
      return { id: n.id, type: "lab", position: { x: n.pos_x, y: n.pos_y }, data };
    });
    const rfEdges: Edge[] = g.edges.map((e) => {
      const condRaw = (e.condition ?? {}) as Record<string, unknown>;
      // Reply-connector arrows keep their stored condition verbatim.
      if (isConnectorHandle(condRaw.handle as string)) {
        const isAny = (condRaw.kind as string) === "any";
        const isTimeout = (condRaw.kind as string) === "timeout";
        const value = (condRaw.value as string) ?? "";
        const scn = scenarios.find((s) => s.intent_key === value);
        return {
          id: e.id,
          source: e.source_node_id,
          target: e.target_node_id,
          type: e.source_node_id === e.target_node_id ? "selfloop" : undefined,
          sourceHandle: condRaw.handle as string,
          label: isTimeout ? "customer stays silent" : isAny ? "anything else" : scn ? snip(scn.name, 18) : "",
          style: isTimeout
            ? { stroke: "#38bdf8", strokeDasharray: "3 3" }
            : isAny
              ? { stroke: "#34d399", strokeDasharray: "3 3" }
              : { stroke: "#34d399" },
          data: { condition: condRaw },
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }
      const handle = (condRaw.handle as string | undefined) ?? "out";
      return {
        id: e.id,
        source: e.source_node_id,
        target: e.target_node_id,
        sourceHandle: handle !== "out" ? handle : undefined,
        ...plainEdgeVisual(),
        data: { condition: { ...condRaw, handle } },
        markerEnd: { type: MarkerType.ArrowClosed },
      };
    });
    return { rfNodes, rfEdges };
  }

  async function loadScript(id: string) {
    setScriptId(id);
    setSelNodeId(null);
    setSelEdgeId(null);
    setLineDrafts({});
    setConnDescDrafts({});
    setWarnings([]);
    setDirty(false);
    undoStack.current = [];
    redoStack.current = [];
    try {
      const { rfNodes, rfEdges } = graphToFlow(await getScriptGraph(id));
      setNodes(rfNodes);
      setEdges(rfEdges);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load script");
    }
  }

  // ── Sub-workflow preview (double-click a sub-workflow box) ──
  const [preview, setPreview] = useState<{ id: string; name: string; nodes: Node[]; edges: Edge[] } | null>(null);
  async function openPreview(subId: string) {
    try {
      const { rfNodes, rfEdges } = graphToFlow(await getScriptGraph(subId));
      setPreview({ id: subId, name: scriptName(subId) ?? "Sub-workflow", nodes: rfNodes, edges: rfEdges });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to open sub-workflow");
    }
  }
  function onNodeDoubleClick(_: React.MouseEvent, n: Node) {
    const d = n.data as NodeData;
    if (d.kind === "step" && (d.config.contentType as Content) === "subworkflow" && d.config.subworkflowId) {
      openPreview(d.config.subworkflowId as string);
    }
  }

  function plainEdgeVisual(): Partial<Edge> {
    return { label: "", style: { stroke: "#6b7280" } };
  }

  // Condition + visual for an arrow leaving a given handle: a reply connector
  // carries its scenario as an intent condition; everything else is plain.
  const edgeBitsForHandle = useCallback(
    (sourceId: string | null, handle: string | null | undefined): { condition: Record<string, unknown>; visual: Partial<Edge> } => {
      const h = handle ?? "out";
      if (isConnectorHandle(h) && sourceId) {
        const src = nodes.find((n) => n.id === sourceId);
        const conn = src ? connectorsOf((src.data as NodeData).config).find((x) => x.id === h) : undefined;
        if (conn?.silence)
          return {
            condition: { kind: "timeout", handle: h },
            visual: { label: "customer stays silent", style: { stroke: "#38bdf8", strokeDasharray: "3 3" } },
          };
        if (conn?.any)
          return {
            condition: { kind: "any", handle: h },
            visual: { label: "anything else", style: { stroke: "#34d399", strokeDasharray: "3 3" } },
          };
        const scn = conn?.intentKey ? scenarios.find((s) => s.intent_key === conn.intentKey) : undefined;
        return {
          condition: { kind: "intent", by: "intent", value: conn?.intentKey ?? "", handle: h },
          visual: { label: scn ? snip(scn.name, 18) : "", style: { stroke: "#34d399" } },
        };
      }
      return { condition: { kind: "plain", handle: h }, visual: plainEdgeVisual() };
    },
     
    [nodes, scenarios]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      snapshot();
      const bits = edgeBitsForHandle(c.source, c.sourceHandle);
      // Without an explicit id, xyflow names the edge "xy-edge__…" — the DB
      // id column is uuid, so every save would be rejected.
      const id = crypto.randomUUID();
      setEdges((eds) =>
        addEdge(
          {
            ...c,
            id,
            ...bits.visual,
            data: { condition: bits.condition },
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          eds
        )
      );
      // A connector arrow with no reply picked yet: open the arrow's panel so
      // the pick happens right as the line lands.
      if (isConnectorHandle(c.sourceHandle) && !(bits.condition.value as string)) {
        setSelEdgeId(id);
        setSelNodeId(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEdges, edgeBitsForHandle]
  );

  // Reconnecting an existing arrow's endpoint — if it's dropped on nothing, delete it.
  const reconnectOk = useRef(true);
  function onReconnectStart() {
    reconnectOk.current = false;
  }
  function onReconnect(oldEdge: Edge, c: Connection) {
    snapshot();
    reconnectOk.current = true;
    const bits = edgeBitsForHandle(c.source, c.sourceHandle);
    setEdges((els) =>
      reconnectEdge(oldEdge, c, els).map((e) =>
        e.id === oldEdge.id
          ? {
              ...e,
              ...bits.visual,
              data: { condition: bits.condition },
            }
          : e
      )
    );
  }
  function onReconnectEnd(_: unknown, edge: Edge) {
    if (!reconnectOk.current) setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    reconnectOk.current = true;
  }

  // ── Add / drag nodes ──
  function dropNode(data: NodeData, position?: { x: number; y: number }) {
    snapshot();
    const id = crypto.randomUUID();
    annotate(data);
    setNodes((ns) => [...ns, { id, type: "lab", position: position ?? { x: 140 + ns.length * 30, y: 80 + ns.length * 30 }, data }]);
    setSelNodeId(id);
    setSelEdgeId(null);
  }
  // payload is "start" or a Content type ("scenario","collection","subworkflow","wait","ifelse","loop","end").
  function createBox(payload: string, position?: { x: number; y: number }) {
    if (payload === "start") {
      dropNode({ kind: "start", label: "Start call", scenarioId: null, config: { mode: "agent_first" } }, position);
      return;
    }
    const content = payload as Content;
    if (!CONTENT_META[content]) return;
    const config: Record<string, unknown> = { contentType: content };
    if (content === "wait") {
      // A Wait box listens for the customer's reply — and ships with a
      // silence path so "they said nothing" is an authored route, not a
      // stall: after waitSeconds of quiet the sky-blue dot's arrow fires.
      config.waitSeconds = 8;
      config.connectors = [{ id: "c:" + crypto.randomUUID(), intentKey: "", silence: true, label: "customer stays silent" }];
    }
    dropNode({ kind: "step", label: CONTENT_META[content].label, scenarioId: null, config }, position);
  }
  function onDragStartPalette(e: React.DragEvent, payload: string) {
    e.dataTransfer.setData("application/reactflow", payload);
    e.dataTransfer.effectAllowed = "move";
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const payload = e.dataTransfer.getData("application/reactflow");
    if (!payload || !rf) return;
    createBox(payload, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }

  // If/Else, Loop, Wait and Transfer are gone from the palette: routing
  // lives on each box's reply connectors, repeating = drawing an arrow back
  // up, every box already listens between turns (Wait), and Transfer isn't
  // wired to a real handoff yet. Legacy boxes still render and run for old
  // scripts.
  const PALETTE: { payload: string; label: string; cls: string }[] = [
    { payload: "start", label: "Start call", cls: "border-emerald-500 bg-emerald-500/10" },
    { payload: "scenario", label: "Scenario", cls: "border-indigo-500 bg-indigo-500/10" },
    { payload: "collection", label: "Collection", cls: "border-fuchsia-500 bg-fuchsia-500/10" },
    { payload: "subworkflow", label: "Sub-workflow", cls: "border-teal-500 bg-teal-500/10" },
    { payload: "send_sms", label: "Send SMS", cls: "border-amber-500 bg-amber-500/10" },
    { payload: "return", label: "Return result", cls: "border-lime-500 bg-lime-500/10" },
    { payload: "end", label: "End call", cls: "border-rose-500 bg-rose-500/10" },
  ];

  function patchNodeData(id: string, patch: Partial<NodeData>) {
    snapshot(800);
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        const merged = annotate({ ...(n.data as NodeData), ...patch });
        return { ...n, data: merged };
      })
    );
  }
  function patchConfig(id: string, patch: Record<string, unknown>) {
    snapshot(800);
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n;
        const d = n.data as NodeData;
        const merged = annotate({ ...d, config: { ...d.config, ...patch } });
        return { ...n, data: merged };
      })
    );
  }
  // ── Reply connectors: extra output dots that route by the customer's reply ──
  function addConnector(nodeId: string) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return;
    const cur = connectorsOf((n.data as NodeData).config);
    patchConfig(nodeId, { connectors: [...cur, { id: "c:" + crypto.randomUUID(), intentKey: "" }] });
  }
  // The + button on a canvas box adds a connector and opens the box's panel
  // so the reply can be picked right away.
  useEffect(() => {
    addConnectorRef.fn = (nodeId: string) => {
      addConnector(nodeId);
      setSelNodeId(nodeId);
      setSelEdgeId(null);
    };
    nodeActionRef.fn = (nodeId: string, action: "duplicate" | "toggle" | "delete") => {
      if (action === "delete") deleteNode(nodeId);
      else if (action === "duplicate") duplicateNode(nodeId);
      else {
        const n = nodes.find((x) => x.id === nodeId);
        if (n) patchConfig(nodeId, { disabled: !((n.data as NodeData).config.disabled === true) });
      }
    };
  });

  function deleteNode(nodeId: string) {
    snapshot();
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setLineDrafts((m) => {
      const next = { ...m };
      delete next[nodeId];
      return next;
    });
    if (selNodeId === nodeId) setSelNodeId(null);
  }

  // Duplicate = same content and config, FRESH connector ids (edges reference
  // connector ids, and the copy's dots must not adopt the original's arrows).
  function duplicateNode(nodeId: string) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n || (n.data as NodeData).kind === "start") return;
    snapshot();
    const d = n.data as NodeData;
    const config = {
      ...d.config,
      connectors: connectorsOf(d.config).map((c) => ({ ...c, id: "c:" + crypto.randomUUID() })),
    };
    const id = crypto.randomUUID();
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: "lab",
        position: { x: n.position.x + 48, y: n.position.y + 48 },
        data: annotate({ ...d, label: `${d.label || "Box"} (copy)`, config }),
      },
    ]);
    setSelNodeId(id);
    setSelEdgeId(null);
  }
  function setConnectorIntent(nodeId: string, connId: string, intentKey: string, scnName?: string) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return;
    const nm = scnName ?? scenarios.find((s) => s.intent_key === intentKey)?.name ?? intentKey;
    const cur = connectorsOf((n.data as NodeData).config);
    patchConfig(nodeId, {
      connectors: cur.map((c) => (c.id === connId ? { ...c, intentKey, label: nm } : c)),
    });
    // Arrows already drawn from this dot follow the new rule.
    setEdges((es) =>
      es.map((e) =>
        e.source === nodeId && e.sourceHandle === connId
          ? {
              ...e,
              label: snip(nm, 18),
              data: { condition: { kind: "intent", by: "intent", value: intentKey, handle: connId } },
            }
          : e
      )
    );
  }
  function removeConnector(nodeId: string, connId: string) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return;
    patchConfig(nodeId, { connectors: connectorsOf((n.data as NodeData).config).filter((c) => c.id !== connId) });
    setEdges((es) => es.filter((e) => !(e.source === nodeId && e.sourceHandle === connId)));
  }

  // Quick match words: exact short replies made only of these words route
  // instantly — zero router latency (the webhook's quickMatch fast path).
  function setConnectorQuick(nodeId: string, connId: string, quickWords: string) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return;
    snapshot(800);
    patchConfig(nodeId, {
      connectors: connectorsOf((n.data as NodeData).config).map((c) => (c.id === connId ? { ...c, quickWords } : c)),
    });
  }

  // Toggle a connector between a specific reply and "any other reply"
  // (catch-all: fires when no other connector matched — 'no matter what').
  function setConnectorAny(nodeId: string, connId: string, on: boolean) {
    const n = nodes.find((x) => x.id === nodeId);
    if (!n) return;
    const cur = connectorsOf((n.data as NodeData).config);
    patchConfig(nodeId, {
      connectors: cur.map((c) =>
        c.id === connId ? { ...c, any: on, intentKey: on ? "" : c.intentKey, label: on ? "anything else" : "" } : c
      ),
    });
    setEdges((es) =>
      es.map((e) =>
        e.source === nodeId && e.sourceHandle === connId
          ? on
            ? { ...e, label: "anything else", style: { stroke: "#34d399", strokeDasharray: "3 3" }, data: { condition: { kind: "any", handle: connId } } }
            : { ...e, label: "", style: { stroke: "#34d399" }, data: { condition: { kind: "intent", by: "intent", value: "", handle: connId } } }
          : e
      )
    );
  }

  // The connector's rule is authored as plain language — same as creating a
  // scenario. A connector already bound to a scenario updates its
  // description; a fresh connector gets a matcher scenario created
  // (speak-nothing, action=ignore), added to the ACTIVE campaign collection
  // (the scoped router can't match what isn't in it), and bound to the dot.
  async function saveConnectorRule(sourceId: string, handle: string, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const node = nodes.find((n) => n.id === sourceId);
    const conn = node ? connectorsOf((node.data as NodeData).config).find((c) => c.id === handle) : undefined;
    const existing = conn?.intentKey ? scenarios.find((s) => s.intent_key === conn.intentKey) : undefined;
    try {
      if (existing) {
        if (trimmed === (existing.description ?? "").trim()) return;
        await updateHandler(existing.id, { description: trimmed });
        setScenarios((ss) => ss.map((x) => (x.id === existing.id ? { ...x, description: trimmed } : x)));
        return;
      }
      const scriptNm = (scripts.find((s) => s.id === scriptId)?.name ?? name).trim() || "Script";
      const label = snip(trimmed, 40);
      const taken = new Set(scenarios.map((s) => s.intent_key));
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "reply";
      let key = base;
      for (let i = 2; taken.has(key); i++) key = `${base}_${i}`;
      const h = await createHandler({
        name: label,
        intent_key: key,
        description: trimmed,
        response_template: "", // matcher only — never spoken
        action_type: "ignore",
        delivery: "verbatim",
        tags: [scriptNm, "Reply detector"],
        mode: "listener",
        priority: 100,
        enabled: true,
      });
      // Matchers are routing plumbing, NOT Playbook content — never added to
      // any collection; the runtime always routes the active script's own
      // conditions regardless of campaign collection scope.
      setScenarios((ss) => [h, ...ss]);
      setConnectorIntent(sourceId, handle, key, h.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save the rule");
    }
  }

  function deleteSelected() {
    if (selNodeId) {
      deleteNode(selNodeId);
    } else if (selEdgeId) {
      snapshot();
      setEdges((es) => es.filter((e) => e.id !== selEdgeId));
      setSelEdgeId(null);
    }
  }

  // Create/update the Playbook entries behind inline-authored content:
  // spoken lines on Scenario/End boxes, and "expected reply" matchers on
  // If/Else boxes (speak-nothing scenarios the router classifies against).
  // Returns nodeId → new scenario id (lines) and nodeId → intent key (replies).
  async function persistInlineLines(): Promise<{ created: Map<string, string> }> {
    const created = new Map<string, string>();
    const scriptNm = (scripts.find((s) => s.id === scriptId)?.name ?? name).trim() || "Script";
    const takenKeys = new Set(scenarios.map((s) => s.intent_key));
    const makeKey = (label: string) => {
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "line";
      let key = base;
      for (let i = 2; takenKeys.has(key); i++) key = `${base}_${i}`;
      takenKeys.add(key);
      return key;
    };
    for (const n of nodes) {
      const d = n.data as NodeData;
      const ct = (d.config.contentType as Content) ?? "scenario";
      if (d.kind !== "step") continue;

      if (!LINE_CONTENT.includes(ct) && ct !== "collection") continue; // collection: the Else line
      const draft = lineDrafts[n.id];
      if (!draft) continue; // untouched box
      const text = draft.text.trim();
      if (!text) continue; // never wipe a line via an emptied box
      // Scenario, collection-else and goodbye lines honour the chosen
      // delivery; SMS confirmations and transfer lines stay exact.
      const delivery = ct === "send_sms" || ct === "transfer" ? "verbatim" : draft.delivery;
      if (d.scenarioId) {
        const scn = scenarios.find((s) => s.id === d.scenarioId);
        if (!scn) continue;
        const hint = draft.hint.trim();
        if (text === scn.response_template && delivery === scn.delivery && hint === (scn.description ?? "").trim()) continue;
        await updateHandler(d.scenarioId, {
          response_template: text,
          delivery,
          description: hint || scn.description,
        });
      } else {
        const label = d.label.trim() || text.slice(0, 40);
        const h = await createHandler({
          name: label,
          intent_key: makeKey(label),
          description: draft.hint.trim() || `Step "${label}" of the "${scriptNm}" script.`,
          response_template: text,
          action_type: ct === "end" ? "end_call" : ct === "send_sms" ? "send_sms" : "answer",
          delivery,
          tags: [scriptNm],
          mode: "both",
          priority: 100,
          enabled: true,
        });
        created.set(n.id, h.id);
      }
    }
    return { created };
  }

  // ── Run mode: live test call with "you are here" on the canvas ──
  type QaIssue = { text: string; suggestion?: string };
  type QaResult = { errors: QaIssue[]; warnings: QaIssue[] };
  type RunStatus = "idle" | "connecting" | "live" | "ended";
  const [run, setRun] = useState<{
    callId: string | null;
    status: RunStatus;
    currentNodeId: string | null;
    visited: string[];
    lastLine: string | null;
    /** The most recent box-to-box transition — INCLUDING self-hops (a
     *  collection answering in place), which visited-dedup would hide. */
    lastHop: { from: string; to: string } | null;
  }>({
    callId: null,
    status: "idle",
    currentNodeId: null,
    visited: [],
    lastLine: null,
    lastHop: null,
  });
  const [qa, setQa] = useState<QaResult | null>(null);
  const [qaBusy, setQaBusy] = useState(false);
  const lastRunEvId = useRef(0);
  // Everything the call has produced so far — feeds the live dock's three
  // views (transcript / listener / thinking).
  const [runEvents, setRunEvents] = useState<LabCallEvent[]>([]);
  const [runPanelOpen, setRunPanelOpen] = useState(true);
  // Dock sizing: drag the top edge to resize, or toggle fullscreen.
  const [dockH, setDockH] = useState(() => {
    try {
      return Number(window.localStorage.getItem("lab_dock_h")) || 240;
    } catch {
      return 240;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("lab_dock_h", String(dockH));
    } catch {
      /* private mode */
    }
  }, [dockH]);
  const [dockFull, setDockFull] = useState(false);
  function startDockDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startH = dockH;
    const move = (ev: MouseEvent) =>
      setDockH(Math.min(Math.max(140, startH + (startY - ev.clientY)), Math.round(window.innerHeight * 0.75)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }
  // Run history: past calls of this script (null = closed).
  const [history, setHistory] = useState<{ call_id: string; current_node_id: string | null; updated_at: string; turns?: number }[] | null>(null);
  const [histBusy, setHistBusy] = useState(false);

  async function openHistory() {
    if (!scriptId) return;
    setHistBusy(true);
    setHistory([]);
    try {
      const rows = await listScriptRuns(scriptId, 25);
      const counts = await utteranceCounts(rows.map((r) => r.call_id)).catch(() => ({}) as Record<string, number>);
      setHistory(rows.map((r) => ({ ...r, turns: counts[r.call_id] ?? 0 })));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load run history");
      setHistory(null);
    } finally {
      setHistBusy(false);
    }
  }

  // Replay a past run: load its events into the dock and paint its path on
  // the canvas — the exact same views as a live run, in "ended" state.
  async function viewRun(row: { call_id: string; current_node_id: string | null }) {
    try {
      const evs = await listLabCallEvents(row.call_id, 0);
      const flowNodes = evs
        .map((e) => (e.meta as Record<string, unknown> | null)?.toNode as string | undefined)
        .filter((x): x is string => !!x);
      const startId = nodes.find((n) => (n.data as NodeData).kind === "start")?.id;
      const visited = [...new Set([...(startId ? [startId] : []), ...flowNodes])];
      const spoken = [...evs].reverse().find((e) => e.event_type === "injected" || e.event_type === "agent_said");
      lastRunEvId.current = evs.length ? evs[evs.length - 1].id : 0;
      setRunEvents(evs);
      setRunPanelOpen(true);
      setRun({ callId: row.call_id, status: "ended", currentNodeId: row.current_node_id, visited, lastLine: spoken?.content ?? null, lastHop: null });
      setHistory(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load the run");
    }
  }

  // Built-in QA: everything that would keep a call from being a full
  // conversation — broken connections, dead ends, no way to finish, and
  // replies the campaign's router can't even see.
  async function preflight(): Promise<QaResult> {
    const errors: QaIssue[] = [];
    const warnings: QaIssue[] = [];
    const outsOf = (id: string) => edges.filter((e) => e.source === id);
    const dataOf = (n: Node) => n.data as NodeData;
    const ctOf = (n: Node) => (dataOf(n).kind === "start" ? "start" : ((dataOf(n).config.contentType as Content) ?? "scenario"));
    const labelOf = (n: Node) => dataOf(n).label || "Box";
    const isTerminal = (n: Node) => ["end", "transfer", "return"].includes(ctOf(n));

    const start = nodes.find((n) => dataOf(n).kind === "start");
    if (!start) errors.push({ text: "There is no Start call box.", suggestion: "Drag a Start call box from the palette — the call has nowhere to begin." });

    // What can the call actually reach from Start?
    const reach = new Set<string>();
    if (start) {
      const q = [start.id];
      while (q.length) {
        const id = q.shift()!;
        if (reach.has(id)) continue;
        reach.add(id);
        for (const e of outsOf(id)) q.push(e.target);
      }
    }

    for (const n of nodes) {
      const d = dataOf(n);
      const ct = ctOf(n);
      const lb = labelOf(n);
      connectorsOf(d.config).forEach((c, i) => {
        const cname = c.label ? `“${snip(c.label, 24)}”` : `#${i + 1}`;
        if (!outsOf(n.id).some((e) => e.sourceHandle === c.id))
          errors.push({
            text: `“${lb}”: ${c.silence ? "silence path" : `reply connector ${cname}`} has no arrow.`,
            suggestion: c.silence
              ? "Drag the sky-blue dot to the box the call should move to when the customer stays quiet."
              : "Drag the green dot to the box this reply should lead to — or remove the dot from its arrow panel.",
          });
        if (c.any || c.silence) return; // catch-all and silence paths need no rule
        if (!c.intentKey)
          errors.push({ text: `“${lb}”: reply connector ${cname} has no rule.`, suggestion: "Click its arrow and describe when the agent should use it." });
        else {
          const scn = scenarios.find((s) => s.intent_key === c.intentKey);
          if (!scn)
            errors.push({ text: `“${lb}”: connector ${cname} points at a reply that no longer exists.`, suggestion: "Click the arrow and write its rule again." });
          else if (!scn.enabled)
            errors.push({
              text: `“${lb}”: connector ${cname} routes on “${snip(scn.name, 28)}” which is toggled OFF in the Playbook — the router can never match it.`,
              suggestion: "Toggle the scenario on in the Playbook, or point the connector at a different reply.",
            });
        }
      });
      if (ct === "start") {
        if (outsOf(n.id).length === 0)
          errors.push({ text: "Start call has no arrows out — the call can never move past the opening.", suggestion: "Click + on Start and add a connector for each reply you expect after the opening." });
        continue;
      }
      if (!reach.has(n.id)) warnings.push({ text: `“${lb}” can never be reached from Start.`, suggestion: "Connect an arrow to it, or delete it." });
      if (ct === "scenario" && !d.scenarioId && !(lineDrafts[n.id]?.text ?? "").trim())
        errors.push({ text: `“${lb}” has no line to speak.`, suggestion: "Click the box and type what the agent should say there." });
      if (d.scenarioId) {
        const scn = scenarios.find((s) => s.id === d.scenarioId);
        if (scn && !scn.enabled)
          warnings.push({
            text: `“${lb}” speaks “${snip(scn.name, 28)}” which is toggled OFF in the Playbook.`,
            suggestion: "Toggle it on, or pick a different line — off usually means 'don't use this anymore'.",
          });
      }
      if (ct === "collection" && !d.config.collectionId)
        errors.push({ text: `“${lb}” has no collection picked.`, suggestion: "Click the box and pick the collection of replies it should answer." });
      if (ct === "subworkflow" && !d.config.subworkflowId) errors.push({ text: `“${lb}” has no workflow picked.` });
      if (ct === "transfer" && !((d.config.number as string) ?? "").trim()) warnings.push({ text: `“${lb}” has no phone number.` });
      if (!isTerminal(n) && reach.has(n.id) && outsOf(n.id).length === 0)
        warnings.push({ text: `“${lb}” is a dead end — the call parks there until the customer hangs up.`, suggestion: "Add a reply connector (e.g. the customer says okay / goodbye) leading onward or to an End call box." });
    }

    const terminals = nodes.filter((n) => isTerminal(n));
    if (!terminals.length)
      warnings.push({ text: "There is no End call box — the agent can never close the call itself.", suggestion: "Add an End call box with a goodbye line and route a reply connector to it." });
    else if (start && !terminals.some((t) => reach.has(t.id)))
      warnings.push({ text: "No End call (or Transfer) box is reachable from Start.", suggestion: "Route at least one chain of connectors all the way to an End call box." });

    // NOTE: no campaign-collection membership check — the runtime always
    // routes the active script's own vocabulary (connector conditions and
    // referenced collections' members), regardless of collection scope.
    for (const n of nodes) {
      const d = dataOf(n);
      if (ctOf(n) !== "collection" || !d.config.collectionId) continue;
      const ids = await getCollectionHandlerIds(d.config.collectionId as string).catch(() => [] as string[]);
      if (!ids.length) warnings.push({ text: `“${labelOf(n)}” points at an empty collection.`, suggestion: "Add reply scenarios to it in the Playbook." });
      const offMembers = scenarios.filter((s) => ids.includes(s.id) && !s.enabled && s.action_type !== "ignore");
      if (offMembers.length)
        warnings.push({
          text: `“${labelOf(n)}”: ${offMembers.length} repl${offMembers.length > 1 ? "ies" : "y"} in its collection ${offMembers.length > 1 ? "are" : "is"} toggled OFF and won't be matched: ${offMembers.map((s) => `“${snip(s.name, 24)}”`).join(", ")}.`,
          suggestion: "Toggle them on in the Playbook, or remove them from the collection.",
        });
    }
    return { errors, warnings };
  }

  // Run button: save → QA → (if clean) the Start button appears in the panel.
  async function handleRunClick() {
    if (run.status === "live" || run.status === "connecting") {
      stopRun();
      return;
    }
    if (run.status === "ended") {
      setRun({ callId: null, status: "idle", currentNodeId: null, visited: [], lastLine: null, lastHop: null });
      setRunEvents([]);
      return;
    }
    if (!scriptId) return;
    setQaBusy(true);
    try {
      if (dirty) await handleSave(); // auto-save before running — the runtime walks the DB
      setQa(await preflight());
    } finally {
      setQaBusy(false);
    }
  }

  async function startRun() {
    setQa(null);
    setError(null);
    try {
      // The webhook walks the ACTIVE script — make this one active first.
      if (activeScriptId !== scriptId && scriptId) {
        await saveLabSettings({ active_script_id: scriptId });
        setActiveScriptId(scriptId);
      }
      const aid =
        labAssistantId ||
        (((await getLabSettings().catch(() => null)) as unknown as { lab_assistant_id?: string } | null)?.lab_assistant_id ?? "");
      if (!aid) {
        setError("Pick the voice agent in the top bar first — that's the VAPI assistant the test call dials.");
        return;
      }
      lastRunEvId.current = 0;
      setRunEvents([]);
      setRunPanelOpen(true);
      setRun({ callId: null, status: "connecting", currentNodeId: null, visited: [], lastLine: null, lastHop: null });
      // Push webhook/persona config before dialing, same as the Lab's panel.
      await fetch("/api/lab/configure-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantId: aid }),
      }).catch(() => {});
      const startNode = nodes.find((n) => (n.data as NodeData).kind === "start");
      // Empty opening is a deliberate author choice: no override, the VAPI
      // assistant's own greeting plays.
      const startCfg = (((startNode?.data as NodeData) ?? {}).config ?? {}) as Record<string, unknown>;
      const opening = ((startCfg.opening as string) ?? "").trim();
      const rendered = opening ? opening.replace(/\{\{\s*name\s*\}\}/gi, "there").replace(/\s{2,}/g, " ") : "";
      // Reworded opening: configure-assistant put the gist in the prompt; the
      // model generates the first message in its own words.
      const openingReword = ((startCfg.openingDelivery as string) ?? "verbatim") === "reword";
      const vapi = getVapi();
      const call = await vapi.start(
        aid,
        rendered
          ? openingReword
            ? { firstMessageMode: "assistant-speaks-first-with-model-generated-message" }
            : { firstMessage: rendered, firstMessageMode: "assistant-speaks-first" }
          : undefined
      );
      if (call?.id) {
        // The engine only persists its position after the first routed turn —
        // paint the Start box as "you are here" from second zero.
        const startId = startNode?.id ?? null;
        setRun((r) => ({ ...r, callId: call.id, status: "live", currentNodeId: startId, visited: startId ? [startId] : [] }));
        if (rendered && !openingReword)
          insertLabEvent({ call_id: call.id, event_type: "injected", role: "assistant", content: rendered, action_type: "opening", meta: { opening: true } }).catch(() => {});
      } else {
        setRun({ callId: null, status: "idle", currentNodeId: null, visited: [], lastLine: null, lastHop: null });
      }
    } catch (err: unknown) {
      setError(vapiErrorText(err, "Failed to start the test call"));
      setRun({ callId: null, status: "idle", currentNodeId: null, visited: [], lastLine: null, lastHop: null });
    }
  }

  function stopRun() {
    try {
      getVapi().stop();
    } catch {
      /* already stopped */
    }
    setRun((r) => (r.callId ? { ...r, status: "ended" } : { callId: null, status: "idle", currentNodeId: null, visited: [], lastLine: null, lastHop: null }));
  }

  // While the call runs, follow it: flow state says WHERE we are, the event
  // log says what was last spoken and when the call ends.
  useEffect(() => {
    if (!run.callId || (run.status !== "live" && run.status !== "connecting")) return;
    const callId = run.callId;
    const timer = setInterval(async () => {
      try {
        // Watchdog tick: serverless freezes background timers and the VAPI
        // webhook goes silent exactly when a briefing is swallowed (nobody
        // speaking → no events), so this poll is the server's clock. Fire
        // and forget — the poll must not wait on it.
        fetch("/api/lab/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ callId }),
        }).catch(() => {});
        const [state, evs] = await Promise.all([
          getFlowState(callId).catch(() => null),
          listLabCallEvents(callId, lastRunEvId.current).catch(() => []),
        ]);
        if (evs.length) {
          lastRunEvId.current = evs[evs.length - 1].id;
          setRunEvents((prev) => [...prev, ...evs]);
          const spoken = [...evs].reverse().find((e) => e.event_type === "injected" || e.event_type === "agent_said");
          const ended = evs.some((e) => e.event_type === "status" && ["ended", "end-of-call-report"].includes((e.content ?? "").trim()));
          const flowNodes = evs.map((e) => (e.meta as Record<string, unknown> | null)?.toNode as string | undefined).filter((x): x is string => !!x);
          setRun((r) => {
            // Walk the hops in order so self-hops (a box answering in place)
            // register too — that's the only visual signal for those turns.
            let cur = r.currentNodeId;
            let lastHop = r.lastHop;
            for (const t of flowNodes) {
              lastHop = { from: cur ?? t, to: t };
              cur = t;
            }
            return {
              ...r,
              lastLine: spoken?.content ?? r.lastLine,
              status: ended ? "ended" : r.status,
              visited: [...new Set([...r.visited, ...flowNodes])],
              currentNodeId: cur,
              lastHop,
            };
          });
        }
        const nid = state?.current_node_id ?? null;
        if (nid)
          setRun((r) =>
            r.currentNodeId === nid ? r : { ...r, currentNodeId: nid, visited: r.visited.includes(nid) ? r.visited : [...r.visited, nid] }
          );
      } catch {
        /* transient poll errors are fine */
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [run.callId, run.status]);

  // Closing the builder mid-call must not leave a headless call running.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(
    () => () => {
      if (runRef.current.status === "live" || runRef.current.status === "connecting") {
        try {
          getVapi().stop();
        } catch {
          /* already stopped */
        }
      }
    },
    []
  );

  // The box palette collapses to a slim rail — and gets out of the way by
  // itself while a test call is running, so the canvas is the monitor.
  const [paletteOpen, setPaletteOpen] = useState(true);
  useEffect(() => {
    if (run.status === "connecting" || run.status === "live") setPaletteOpen(false);
    else if (run.status === "idle") setPaletteOpen(true);
  }, [run.status]);

  // Zoom out to the whole workflow whenever the run view changes size — on
  // start (palette collapses, dock rises), on dock expand/collapse, and when
  // the run ends — so every box is always in view.
  useEffect(() => {
    if (run.status === "idle") return;
    const t = setTimeout(() => rf?.fitView({ padding: 0.2, duration: 400 }), 350);
    return () => clearTimeout(t);
  }, [run.status, runPanelOpen, dockFull, paletteOpen, rf]);

  // Paint the call's position onto the canvas (display-only).
  const displayNodes = useMemo(() => {
    if (run.status === "idle") return nodes;
    return nodes.map((n) => {
      const cur = n.id === run.currentNodeId;
      const seen = run.visited.includes(n.id);
      if (!cur && !seen) return n;
      return { ...n, data: { ...(n.data as NodeData), runState: cur ? ("current" as const) : ("visited" as const) } };
    });
  }, [nodes, run]);

  // Non-blocking sanity checks a CRM user would otherwise discover mid-call.
  function validateGraph(): string[] {
    const w: string[] = [];
    const outsOf = (id: string) => edges.filter((e) => e.source === id);
    const handleOf = (e: Edge) =>
      ((e.data as { condition?: { handle?: string } })?.condition?.handle ?? e.sourceHandle ?? "out") as string;
    const targeted = new Set(edges.map((e) => e.target));
    for (const n of nodes) {
      const d = n.data as NodeData;
      const label = d.label || "Box";
      // Reply connectors need an arrow, and (unless catch-all) a picked reply.
      connectorsOf(d.config).forEach((c, i) => {
        const cname = c.label ? `“${snip(c.label, 24)}”` : `#${i + 1}`;
        if (!c.any && !c.silence && !c.intentKey) w.push(`“${label}” reply connector ${cname} has no reply picked.`);
        if (!outsOf(n.id).some((e) => (e.sourceHandle ?? handleOf(e)) === c.id))
          w.push(`“${label}” ${c.silence ? "silence path" : `reply connector ${cname}`} has no arrow.`);
      });
      if (d.kind === "start") continue;
      const ct = (d.config.contentType as Content) ?? "scenario";
      if (ct === "scenario" && !d.scenarioId && !(lineDrafts[n.id]?.text ?? "").trim())
        w.push(`“${label}” has no line to speak.`);
      if (ct === "subworkflow" && !d.config.subworkflowId) w.push(`“${label}” has no workflow picked.`);
      if (ct === "transfer" && !((d.config.number as string) ?? "").trim()) w.push(`“${label}” has no phone number.`);
      if (ct === "collection" && !d.config.collectionId) w.push(`“${label}” has no collection picked.`);
    }
    // Exactly one entry point is expected: the Start box, or (in a phase
    // sub-workflow without one) a single unconnected first box.
    const hasStart = nodes.some((n) => (n.data as NodeData).kind === "start");
    const loose = nodes.filter((n) => (n.data as NodeData).kind !== "start" && !targeted.has(n.id)).length;
    const allowed = hasStart ? 0 : 1;
    if (loose > allowed) w.push(`${loose - allowed} box(es) are not connected to the flow and will never run.`);
    return w;
  }

  async function handleSave() {
    if (!scriptId) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const { created } = await persistInlineLines();
      const scenarioIdFor = (n: Node) => created.get(n.id) ?? (n.data as NodeData).scenarioId;
      const configFor = (n: Node) => (n.data as NodeData).config ?? {};
      const nodeRows = nodes.map((n) => {
        const d = n.data as NodeData;
        const ct = (d.config.contentType ?? "scenario") as Content;
        return {
          id: n.id,
          type: d.kind, // 'start' | 'step'
          // Collections carry a default-line scenario; line boxes carry theirs.
          scenario_id: LINE_CONTENT.includes(ct) || ct === "collection" ? scenarioIdFor(n) : null,
          label: d.label,
          config: configFor(n),
          pos_x: n.position.x,
          pos_y: n.position.y,
        };
      });
      // Arrows drawn before edges got explicit ids still carry xyflow's
      // "xy-edge__…" name in canvas state — re-key those to real uuids.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const keyedEdges = edges.map((e) => (UUID_RE.test(e.id) ? e : { ...e, id: crypto.randomUUID() }));
      if (keyedEdges.some((e, i) => e !== edges[i])) setEdges(keyedEdges);
      const edgeRows = keyedEdges.map((e) => {
        const cond = ((e.data as { condition?: Record<string, unknown> })?.condition ?? { kind: "plain" }) as Record<string, unknown>;
        const handle = (e.sourceHandle ?? (cond.handle as string) ?? "out") as string;
        // Persist which output handle the arrow leaves from inside condition.
        let condition: Record<string, unknown> = { ...cond, handle };
        // Reply-connector arrows: re-derive the intent from the box's current
        // connector definition — the node config is the source of truth.
        if (isConnectorHandle(handle)) {
          const src = nodes.find((n) => n.id === e.source);
          const conn = src ? connectorsOf((src.data as NodeData).config).find((x) => x.id === handle) : undefined;
          condition = conn?.silence
            ? { kind: "timeout", handle }
            : conn?.any
              ? { kind: "any", handle }
              : { kind: "intent", by: "intent", value: conn?.intentKey ?? (cond.value as string) ?? "", handle };
        }
        return {
          id: e.id,
          source_node_id: e.source,
          target_node_id: e.target,
          condition,
          label: typeof e.label === "string" ? e.label : "",
        };
      });
      await saveScriptGraph(scriptId, nodeRows, edgeRows);
      // Reflect newly created scenarios/reply matchers on their boxes, refresh
      // the Playbook list, and drop drafts so they reseed from saved data.
      if (created.size) {
        setNodes((ns) =>
          ns.map((n) => {
            if (!created.has(n.id)) return n;
            const d = { ...(n.data as NodeData) };
            d.scenarioId = created.get(n.id)!;
            return { ...n, data: d };
          })
        );
      }
      const found = validateGraph();
      setWarnings(found);
      setScenarios(await listHandlers());
      setLineDrafts({});
      setDirty(false);
      setNotice(found.length ? `Saved — ${found.length} thing${found.length > 1 ? "s" : ""} to check.` : "Script saved.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteScript() {
    if (!scriptId || !window.confirm("Delete this script and its flow?")) return;
    try {
      await deleteScript(scriptId);
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }
  async function handleDuplicateScript() {
    // The copy is made from the SAVED graph — unsaved canvas changes stay on
    // the original, so the usual dirty guard decides what happens to them.
    if (!scriptId || !confirmDiscard()) return;
    setBusy(true);
    try {
      const copy = await duplicateScript(scriptId, `${name.trim() || "Untitled workflow"} (copy)`);
      setScripts(await listScripts());
      await loadScript(copy.id);
      setNotice("Duplicated — now editing the copy.");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to duplicate");
    } finally {
      setBusy(false);
    }
  }
  async function toggleActive() {
    if (!scriptId) return;
    const next = activeScriptId === scriptId ? null : scriptId;
    try {
      await saveLabSettings({ active_script_id: next });
      setActiveScriptId(next);
      setNotice(next ? "Active for test calls." : null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  const selNode = nodes.find((n) => n.id === selNodeId) ?? null;
  const sd = selNode ? (selNode.data as NodeData) : null;
  const selEdge = edges.find((e) => e.id === selEdgeId) ?? null;
  const content = (sd?.config.contentType as Content) ?? "scenario";

  // Inline line editing: drafts are seeded from the box's scenario and only
  // written back to the Playbook on Save.
  function seedDraft(d: NodeData): LineDraft {
    const scn = d.scenarioId ? scenarios.find((s) => s.id === d.scenarioId) : undefined;
    return {
      text: scn?.response_template ?? "",
      // Gist by default — natural phrasing beats recital for most lines.
      delivery: scn?.delivery ?? "reword",
      hint: scn?.description ?? "",
    };
  }
  const draft =
    selNode && sd && sd.kind === "step" && (LINE_CONTENT.includes(content) || content === "collection")
      ? lineDrafts[selNode.id] ?? seedDraft(sd)
      : null;
  function patchDraft(nodeId: string, base: LineDraft, patch: Partial<LineDraft>) {
    setDirty(true);
    setLineDrafts((m) => ({ ...m, [nodeId]: { ...(m[nodeId] ?? base), ...patch } }));
    // Live-preview the line and description on the canvas box while typing.
    const next = { ...base, ...patch };
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== nodeId) return n;
        // Collection boxes keep their collection-name subtitle — the Else
        // line lives in the drawer, not on the box face.
        if (((n.data as NodeData).config.contentType as Content) === "collection") return n;
        const d = { ...(n.data as NodeData) };
        d.subtitle = next.text.trim() ? `“${snip(next.text, 42)}”` : subtitleFor(d);
        d.note = next.hint.trim() ? snip(next.hint, 64) : null;
        return { ...n, data: d };
      })
    );
  }
  // Switching the underlying scenario reseeds the draft from the new pick.
  function pickScenario(nodeId: string, scenarioId: string | null) {
    patchNodeData(nodeId, { scenarioId });
    setLineDrafts((m) => {
      const next = { ...m };
      delete next[nodeId];
      return next;
    });
  }

  // Loop-back arrows (target box sits above the source) render as a dashed
  // line so a repeat reads differently from the forward flow. During a run,
  // the arrows the call actually walked light up emerald (consecutive
  // visited boxes) and the arrow INTO the current box animates — the
  // transition is visible, not just the boxes. Display-only.
  const displayEdges = useMemo(() => {
    const posY = new Map(nodes.map((n) => [n.id, n.position.y]));
    const walkedPairs = new Set<string>();
    for (let i = 0; i + 1 < run.visited.length; i++) walkedPairs.add(run.visited[i] + ">" + run.visited[i + 1]);
    // While the customer is still talking, glow the connector the live
    // speculation points at (or the catch-all when nothing specific fits) —
    // the chosen path lights up before the turn even ends.
    let specIntent: string | null = null;
    if (run.status === "live") {
      for (let i = runEvents.length - 1; i >= 0; i--) {
        const ev = runEvents[i];
        if (ev.event_type === "classified" || ev.event_type === "injected") break; // turn already resolved
        if (ev.event_type === "speculated") {
          specIntent = ((ev.meta as Record<string, unknown> | null)?.cls as { intent?: string } | undefined)?.intent ?? null;
          break;
        }
      }
    }
    const condOf = (e: Edge) => ((e.data as { condition?: Record<string, unknown> })?.condition ?? {}) as Record<string, unknown>;
    const specMatched =
      !!specIntent && edges.some((e) => e.source === run.currentNodeId && condOf(e).value === specIntent);
    return edges.map((e) => {
      const isSelf = e.source === e.target;
      const up = isSelf || (posY.get(e.target) ?? 0) < (posY.get(e.source) ?? 0);
      let out = up
        ? { ...e, type: isSelf ? "selfloop" : e.type, style: { ...(e.style ?? {}), strokeDasharray: "7 5" } }
        : e;
      if (run.status !== "idle") {
        const walked = walkedPairs.has(e.source + ">" + e.target);
        const intoCurrent = e.target === run.currentNodeId && walked;
        if (walked)
          out = {
            ...out,
            animated: intoCurrent,
            style: { ...(out.style ?? {}), stroke: "#34d399", strokeWidth: 2.5 },
          };
        const c = condOf(e);
        const anticipated =
          specIntent !== null &&
          e.source === run.currentNodeId &&
          (c.value === specIntent || (!specMatched && c.kind === "any"));
        // The most recent hop pulses — including a self-loop answering in
        // place, which the visited-pair trail can't show.
        const justWalked = run.lastHop && e.source === run.lastHop.from && e.target === run.lastHop.to;
        if (anticipated || justWalked)
          out = {
            ...out,
            animated: true,
            style: { ...(out.style ?? {}), stroke: "#6ee7b7", strokeWidth: 3.5 },
          };
      }
      return out;
    });
  }, [edges, nodes, run, runEvents]);

  // Members of the collection a selected Collection box points at — shown as
  // a plain list in the drawer so the builder never has to leave the canvas.
  const [colMembers, setColMembers] = useState<Record<string, string[]>>({});
  useEffect(() => {
    const cid = sd && content === "collection" ? ((sd.config.collectionId as string) ?? null) : null;
    if (!cid || cid in colMembers) return;
    getCollectionHandlerIds(cid)
      .then((ids) => setColMembers((m) => ({ ...m, [cid]: ids })))
      .catch(() => setColMembers((m) => ({ ...m, [cid]: [] })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sd, content]);

  // Drafts for the "when should the agent use this" rule on a connector arrow,
  // keyed by scenario intent key; saved to the Playbook scenario on blur.
  const [connDescDrafts, setConnDescDrafts] = useState<Record<string, string>>({});

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-950">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-800 px-4 py-2.5">
        {/* Script switcher — open any script without leaving the builder */}
        <select
          value={scriptId ?? ""}
          onChange={(e) => e.target.value && confirmDiscard() && loadScript(e.target.value)}
          title="Open another script"
          className="w-56 shrink-0 rounded-md border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none [color-scheme:dark]"
        >
          {!scriptId && <option value="">(open a script…)</option>}
          {scripts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {/* Editable workflow name */}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="Untitled workflow"
          title="Click to rename"
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-bold text-white hover:border-gray-700 focus:border-indigo-500 focus:bg-gray-900 focus:outline-none"
        />

        <div className="flex items-center gap-3">
          {notice && <span className="text-xs text-emerald-400">{notice}</span>}
          {error && <span className="text-xs text-red-400">{error}</span>}

          {/* Active toggle (off by default) */}
          <label className="flex items-center gap-2 text-xs text-gray-400" title="Use this script for test calls">
            <span>Active</span>
            <button
              type="button"
              onClick={toggleActive}
              disabled={!scriptId}
              className={`relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40 ${
                activeScriptId === scriptId ? "bg-emerald-600" : "bg-gray-600"
              }`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${activeScriptId === scriptId ? "left-[18px]" : "left-0.5"}`} />
            </button>
          </label>

          {/* Configuration — the Listener Lab's full config, in the right drawer */}
          <button
            onClick={() => {
              setConfigOpen((o) => !o);
              setSelNodeId(null);
              setSelEdgeId(null);
            }}
            title="Configuration — voice agent, persona, listener tuning (shared with the Listener Lab)"
            className={`rounded-lg border p-2 transition ${
              configOpen ? "border-indigo-500 bg-indigo-500/15 text-indigo-300" : "border-gray-700 text-gray-300 hover:bg-gray-800"
            }`}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Run history: replay past calls of this script */}
          <button
            onClick={openHistory}
            disabled={!scriptId || run.status === "live" || run.status === "connecting"}
            title="Run history — replay past calls of this script"
            className="rounded-lg border border-gray-700 p-2 text-gray-300 transition hover:bg-gray-800 disabled:opacity-40"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>

          {/* Run: save → QA → live test call with the canvas as the monitor */}
          <button
            onClick={handleRunClick}
            disabled={!scriptId || busy || qaBusy}
            title={
              run.status === "live" || run.status === "connecting"
                ? "End the test call"
                : run.status === "ended"
                  ? "Clear the finished run"
                  : "Check the workflow and run a test call"
            }
            className={`rounded-lg p-2 text-white transition disabled:opacity-40 ${
              run.status === "live" || run.status === "connecting" ? "bg-red-600 hover:bg-red-500" : "bg-emerald-600 hover:bg-emerald-500"
            }`}
          >
            {qaBusy ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="42" strokeLinecap="round" /></svg>
            ) : run.status === "live" || run.status === "connecting" ? (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>
            ) : (
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5.14v13.72c0 .84.93 1.35 1.64.9l10.02-6.86a1.06 1.06 0 000-1.8L9.64 4.24A1.06 1.06 0 008 5.14z" /></svg>
            )}
          </button>

          {/* Save */}
          <button onClick={handleSave} disabled={!scriptId || busy || !dirty} title={dirty ? "Save" : "No changes to save"} className="rounded-lg bg-indigo-600 p-2 text-white transition hover:bg-indigo-500 disabled:opacity-40">
            {busy ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="42" strokeLinecap="round" /></svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h9l3 3v11a2 2 0 01-2 2H7a2 2 0 01-2-2V5z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 3v5h6" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 13h8v6H8z" />
              </svg>
            )}
          </button>

          {/* Duplicate workflow */}
          <button onClick={handleDuplicateScript} disabled={!scriptId || busy} title="Duplicate workflow — copy every box and arrow into a new script" className="rounded-lg border border-gray-700 p-2 text-gray-300 transition hover:bg-gray-800 disabled:opacity-40">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          </button>

          {/* Delete */}
          <button onClick={handleDeleteScript} disabled={!scriptId} title="Delete script" className="rounded-lg border border-gray-700 p-2 text-gray-300 transition hover:bg-gray-800 hover:text-rose-400 disabled:opacity-40">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>

          {/* Close */}
          <button onClick={() => confirmDiscard() && onClose()} title="Close" className="rounded-lg border border-gray-700 p-2 text-gray-300 transition hover:bg-gray-800">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Save-time warnings (non-blocking) */}
      {warnings.length > 0 && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-300">
          <div className="flex items-start justify-between gap-3">
            <ul className="list-disc space-y-0.5 pl-5">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <button onClick={() => setWarnings([])} className="shrink-0 text-amber-400/70 hover:text-amber-200">
              dismiss
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Palette (collapsible; auto-collapses while a test call runs) */}
        {!paletteOpen ? (
          <button
            onClick={() => setPaletteOpen(true)}
            title="Show the box palette"
            className="flex w-7 shrink-0 flex-col items-center gap-2 border-r border-gray-800 py-3 text-gray-500 transition hover:bg-gray-900 hover:text-gray-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-[9px] font-semibold uppercase tracking-wider text-gray-600 [writing-mode:vertical-rl]">Boxes</span>
          </button>
        ) : (
        <div className="flex w-44 shrink-0 flex-col border-r border-gray-800">
          <div className="flex shrink-0 items-center justify-between border-b border-gray-800 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Boxes</p>
            <button onClick={() => setPaletteOpen(false)} title="Collapse the palette" className="text-gray-500 transition hover:text-gray-300">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
            {PALETTE.map((b) => (
              <button
                key={b.payload}
                draggable={!!scriptId}
                onDragStart={(e) => onDragStartPalette(e, b.payload)}
                onClick={() => scriptId && createBox(b.payload)}
                disabled={!scriptId}
                title={`Drag onto the canvas`}
                className={`flex w-full cursor-grab items-center gap-1.5 rounded-lg border-2 px-2.5 py-1.5 text-left text-xs font-medium text-gray-200 hover:brightness-125 active:cursor-grabbing disabled:opacity-40 ${b.cls}`}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="shrink-0 border-t border-gray-800 p-2 text-[10px] text-gray-600">
            Drag a box onto the canvas, then click it to configure. Click the <span className="text-emerald-400">+</span> on
            a box to add a reply connector — each green dot is one predicted customer reply; drag its arrow to the next
            box, or back up to an earlier box to repeat it.
          </p>
        </div>
        )}

        {/* Canvas + live-run dock (dock is a real panel below the canvas, so
            zoom-to-fit fits the actually visible area) */}
        <div className="flex min-w-0 flex-1 flex-col" onDrop={onDrop} onDragOver={onDragOver}>
          {/* Live-run dock: transcript / listener / thinking, live from the call */}
          {run.status !== "idle" &&
            (() => {
              const nodeLabel = (id?: unknown) =>
                typeof id === "string" ? ((nodes.find((n) => n.id === id)?.data as NodeData | undefined)?.label ?? null) : null;
              const metaOf = (e: LabCallEvent) => (e.meta ?? {}) as Record<string, unknown>;
              const REASON_TEXT: Record<string, string> = {
                superseded: "a newer reply arrived — stayed quiet",
                self_covered: "the agent already covered it by itself — stayed quiet",
                deferred_to_playbook: "flow parked — the Playbook answers this one",
                concurrent_turn: "duplicate turn dropped",
                cooldown: "too soon after the last line — stayed quiet",
                handler_not_found: "no matching reply — ignored",
                no_handlers: "no matching reply — ignored",
                no_settings: "no matching reply — ignored",
                handler_ignore: "recognized, deliberately not answered",
                flow_owns_action: "the flow owns this action — reactive stood down",
                retrigger: "the line didn't get voiced — nudging the agent again",
                backchannel: "just noise or an acknowledgement — holding position",
                held_at_stage: "no path matched — the agent answers in place, flow held",
              };
              // agent_said covers everything actually spoken (VAPI transcribes
              // the firstMessage too) — including our logged opening would
              // show the greeting twice.
              const transcript = runEvents.filter((e) => e.event_type === "utterance" || e.event_type === "agent_said");
              // Reply latency per agent line: how long the customer actually
              // waited — from their utterance to the assistant speech-START
              // that produced the line (agent_said itself lands at the END of
              // the speech, so its own timestamp would overstate).
              const replyMs = new Map<number, number>();
              {
                let utterAt: number | null = null;
                let speechStartAt: number | null = null; // latest assistant speech-start since the utterance
                for (const e of runEvents) {
                  if (e.event_type === "utterance") {
                    utterAt = new Date(e.created_at).getTime();
                    speechStartAt = null;
                  } else if (e.event_type === "status" && (e.content ?? "").startsWith("speech-update: started (assistant)")) {
                    speechStartAt = new Date(e.created_at).getTime();
                  } else if (e.event_type === "agent_said" && utterAt != null && speechStartAt != null) {
                    replyMs.set(e.id, Math.max(0, speechStartAt - utterAt));
                    speechStartAt = null; // consumed — the next line needs its own start
                  }
                }
              }
              const replyTag = (e: LabCallEvent) =>
                replyMs.has(e.id) ? `${(replyMs.get(e.id)! / 1000).toFixed(1)}s` : null;
              const listener = runEvents.filter(
                (e) =>
                  ["classified", "sms", "error"].includes(e.event_type) ||
                  (e.event_type === "injected" && !metaOf(e).opening && (e.content ?? "") !== "" && metaOf(e).mode !== "skipped_ahead")
              );
              const observer = runEvents.filter(
                (e) =>
                  e.event_type === "speculated" ||
                  e.event_type === "skipped" ||
                  e.event_type === "classified" ||
                  (e.event_type === "injected" &&
                    (((metaOf(e).repeated as number) ?? 0) > 0 ||
                      (!!metaOf(e).flow && ((e.content ?? "") === "" || metaOf(e).mode === "skipped_ahead"))))
              );
              const observerText = (e: LabCallEvent): string => {
                const m = metaOf(e);
                if (e.event_type === "speculated") {
                  const cls = m.cls as { intent?: string; confidence?: number } | undefined;
                  const exp = Array.isArray(m.expected) && (m.expected as string[]).length
                    ? ` — step expects: ${(m.expected as string[]).slice(0, 4).join(", ")}`
                    : "";
                  return (
                    (cls?.intent && cls.intent !== "none"
                      ? `still talking… likely “${cls.intent}” (${Math.round((cls.confidence ?? 0) * 100)}%)`
                      : "still talking… nothing actionable yet") + exp
                  );
                }
                if (e.event_type === "classified") {
                  // Verdict against the FULL expected set — displaying only the
                  // first three once mislabelled a legit member as off-plan.
                  const expFull = Array.isArray(m.expected) ? (m.expected as string[]) : [];
                  const exp = expFull.slice(0, 3);
                  const heard = e.intent_key ?? "none";
                  if (!expFull.length) return `heard “${heard}” — no step expectations here`;
                  return `step expected: ${exp.join(", ")}${expFull.length > 3 ? ", …" : ""} — heard “${heard}”${
                    expFull.includes(heard) ? " ✓ as planned" : heard === "none" ? " (just noise — holding position)" : " — off-plan, rerouting"
                  }`;
                }
                if (e.event_type === "skipped") return REASON_TEXT[(m.reason as string) ?? ""] ?? `skipped (${(m.reason as string) ?? "?"})`;
                if (((m.repeated as number) ?? 0) > 0)
                  return `advised: this was already said ${m.repeated}× — rephrase with new emphasis, don't recite`;
                const lb = nodeLabel(m.toNode);
                if (m.mode === "skipped_ahead") return `passed through ${lb ? `“${lb}”` : "a box"} — the reply answered past it`;
                if (m.mode === "disabled_skipped") return `passed through ${lb ? `“${lb}”` : "a box"} — it's deactivated`;
                return `moved to ${lb ? `“${lb}”` : "the next box"}`;
              };
              // Pinned observer line: what the current box is waiting for —
              // shown the moment a box is entered, before the customer speaks.
              const waitingFor = (() => {
                if (!run.currentNodeId || run.status === "ended") return null;
                const outs = edges.filter((e) => e.source === run.currentNodeId);
                if (!outs.length) return null;
                const parts = outs.map((e) => {
                  const c = ((e.data as { condition?: Record<string, unknown> })?.condition ?? {}) as Record<string, unknown>;
                  const tgt = nodeLabel(e.target) ?? "next box";
                  if (c.kind === "timeout") {
                    const wn = nodes.find((n) => n.id === run.currentNodeId);
                    const secs = Number((wn?.data as NodeData | undefined)?.config.waitSeconds) || 8;
                    return `silent ${secs}s → ${tgt}`;
                  }
                  if (c.kind === "any") return `anything else → ${tgt}`;
                  const scn = scenarios.find((s) => s.intent_key === c.value);
                  return `${scn ? `“${snip(scn.name, 26)}”` : `“${(c.value as string) ?? "?"}”`} → ${tgt}`;
                });
                return `at “${nodeLabel(run.currentNodeId) ?? "…"}” — waiting for: ${parts.join("  ·  ")}`;
              })();
              const col = "flex min-h-0 flex-1 flex-col-reverse gap-1.5 overflow-y-auto overscroll-contain p-3";
              const head = "flex shrink-0 items-center justify-between border-b border-gray-800 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500";
              // Plain-text builders for copy-to-clipboard (chronological).
              const transcriptLine = (e: LabCallEvent) =>
                `${e.event_type === "utterance" ? "Customer" : "Agent"}${replyTag(e) ? ` (${replyTag(e)})` : ""}: ${e.content ?? ""}`;
              const listenerLine = (e: LabCallEvent) => {
                const m = metaOf(e);
                if (e.event_type === "classified")
                  return `heard as "${e.intent_key}" (${Math.round(Number(e.confidence ?? 0) * 100)}%)${m.speculative ? " — pre-thought while they spoke" : ""}`;
                if (e.event_type === "sms") return `sms: ${e.content ?? ""}`;
                if (e.event_type === "error") return `error: ${e.content ?? ""}`;
                return `${m.flow ? "script" : "playbook"}: ${e.content ?? ""}${e.latency_ms != null ? ` (${(e.latency_ms / 1000).toFixed(1)}s)` : ""}`;
              };
              const copyCol = (label: string, lines: string[]) => {
                navigator.clipboard
                  .writeText(lines.join("\n"))
                  .then(() => setNotice(`${label} copied to clipboard.`))
                  .catch(() => setError("Couldn't copy — clipboard blocked by the browser."));
              };
              const copyBtn = (label: string, lines: string[]) => (
                <button
                  onClick={() => copyCol(label, lines)}
                  title={`Copy the ${label.toLowerCase()} to the clipboard`}
                  className="shrink-0 rounded p-0.5 text-gray-600 transition hover:bg-gray-800 hover:text-gray-300"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                    />
                  </svg>
                </button>
              );
              return (
                <div className="order-2 flex shrink-0 flex-col border-t border-gray-700 bg-gray-950">
                  {/* Drag the top edge to resize the dock */}
                  {runPanelOpen && (
                    <div
                      onMouseDown={startDockDrag}
                      title="Drag to resize"
                      className="h-1.5 w-full shrink-0 cursor-ns-resize bg-gray-800/60 transition hover:bg-emerald-500/40"
                    />
                  )}
                  {/* Dock header: status, position, controls */}
                  <div className="flex items-center gap-3 px-4 py-2">
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        run.status === "live" ? "animate-pulse bg-emerald-400" : run.status === "connecting" ? "animate-pulse bg-amber-400" : "bg-gray-500"
                      }`}
                    />
                    <span className="shrink-0 text-xs font-semibold text-white">
                      {run.status === "connecting"
                        ? "Connecting…"
                        : run.status === "ended"
                          ? "Call ended"
                          : run.currentNodeId
                            ? `In: ${nodeLabel(run.currentNodeId) ?? "…"}`
                            : "Live — waiting for the first reply"}
                    </span>
                    {!runPanelOpen && run.lastLine && (
                      <span className="min-w-0 truncate text-[11px] italic text-gray-500">“{snip(run.lastLine, 80)}”</span>
                    )}
                    <span className="flex-1" />
                    <button
                      onClick={() => setDockFull((f) => !f)}
                      title={dockFull ? "Exit fullscreen" : "Fullscreen"}
                      className="shrink-0 rounded-md border border-gray-700 p-1 text-gray-400 transition hover:bg-gray-800 hover:text-gray-200"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        {dockFull ? (
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 9H4m5 0V4m6 5h5m-5 0V4M9 15H4m5 0v5m6-5h5m-5 0v5" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4m8 0h4v4m0 8v4h-4M8 20H4v-4" />
                        )}
                      </svg>
                    </button>
                    <button
                      onClick={() => setRunPanelOpen((o) => !o)}
                      title={runPanelOpen ? "Collapse" : "Expand"}
                      className="shrink-0 rounded-md border border-gray-700 p-1 text-gray-400 transition hover:bg-gray-800 hover:text-gray-200"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        {runPanelOpen ? (
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                        )}
                      </svg>
                    </button>
                    {run.status === "ended" ? (
                      <button
                        onClick={() => {
                          setRun({ callId: null, status: "idle", currentNodeId: null, visited: [], lastLine: null, lastHop: null });
                          setRunEvents([]);
                        }}
                        className="shrink-0 rounded-full border border-gray-600 px-2.5 py-0.5 text-[11px] text-gray-300 hover:bg-gray-800"
                      >
                        Dismiss
                      </button>
                    ) : (
                      <button
                        onClick={stopRun}
                        className="shrink-0 rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-semibold text-white hover:bg-red-500"
                      >
                        End call
                      </button>
                    )}
                  </div>
                  {/* Three live views */}
                  {runPanelOpen && (
                    <div
                      className="grid grid-cols-3 divide-x divide-gray-800 border-t border-gray-800"
                      style={{ height: dockFull ? "calc(100vh - 170px)" : dockH }}
                    >
                      <div className="flex min-h-0 min-w-0 flex-col">
                        <p className={head}>
                          <span>Transcript</span>
                          {copyBtn("Transcript", transcript.map(transcriptLine))}
                        </p>
                        <div className={col}>
                          {transcript.length === 0 && <p className="text-[11px] text-gray-600">Waiting for the first words…</p>}
                          {transcript
                            .slice()
                            .reverse()
                            .map((e) => (
                              <p key={e.id} className="text-[11px] leading-snug">
                                <span className={e.event_type === "utterance" ? "font-semibold text-sky-300" : "font-semibold text-teal-300"}>
                                  {e.event_type === "utterance" ? "Customer" : "Agent"}:
                                </span>{" "}
                                <span className="text-gray-300">{e.content}</span>
                                {replyTag(e) && <span className="text-gray-600"> · {replyTag(e)}</span>}
                              </p>
                            ))}
                        </div>
                      </div>
                      <div className="flex min-h-0 min-w-0 flex-col">
                        <p className={head}>
                          <span>Listener</span>
                          {copyBtn("Listener log", listener.map(listenerLine))}
                        </p>
                        <div className={col}>
                          {listener.length === 0 && <p className="text-[11px] text-gray-600">Classifications and lines land here…</p>}
                          {listener
                            .slice()
                            .reverse()
                            .map((e) => (
                              <p key={e.id} className="text-[11px] leading-snug">
                                {e.event_type === "classified" ? (
                                  <>
                                    <span className="font-semibold text-violet-300">heard as</span>{" "}
                                    <span className="text-gray-300">
                                      “{e.intent_key}” ({Math.round(Number(e.confidence ?? 0) * 100)}%)
                                      {metaOf(e).speculative ? " — pre-thought while they spoke" : ""}
                                    </span>
                                  </>
                                ) : e.event_type === "sms" ? (
                                  <>
                                    <span className="font-semibold text-amber-300">sms</span>{" "}
                                    <span className="text-gray-400">{snip(e.content ?? "", 80)}</span>
                                  </>
                                ) : e.event_type === "error" ? (
                                  <>
                                    <span className="font-semibold text-rose-400">error</span>{" "}
                                    <span className="text-gray-400">{snip(e.content ?? "", 80)}</span>
                                  </>
                                ) : (
                                  <>
                                    <span className="font-semibold text-emerald-300">{metaOf(e).flow ? "script" : "playbook"}</span>{" "}
                                    <span className="text-gray-300">{snip(e.content ?? "", 110)}</span>
                                    {e.latency_ms != null && <span className="text-gray-600"> · {(e.latency_ms / 1000).toFixed(1)}s</span>}
                                  </>
                                )}
                              </p>
                            ))}
                        </div>
                      </div>
                      <div className="flex min-h-0 min-w-0 flex-col">
                        <p className={head}>
                          <span>Observer</span>
                          {copyBtn("Observer log", [...observer.map(observerText), ...(waitingFor ? [waitingFor] : [])])}
                        </p>
                        <div className={col}>
                          {waitingFor && (
                            <p className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-1 text-[11px] font-medium leading-snug text-emerald-300">
                              {waitingFor}
                            </p>
                          )}
                          {observer.length === 0 && !waitingFor && (
                            <p className="text-[11px] text-gray-600">The observer narrates every turn here — expectations, verdicts, advice…</p>
                          )}
                          {observer
                            .slice()
                            .reverse()
                            .map((e) => (
                              <p key={e.id} className="text-[11px] italic leading-snug text-gray-400">
                                {observerText(e)}
                              </p>
                            ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
          <div className="relative order-1 min-h-0 flex-1">
          {scriptId ? (
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              onNodesChange={handleNodesChange}
              deleteKeyCode={null}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onReconnectStart={onReconnectStart}
              onReconnectEnd={onReconnectEnd}
              connectionRadius={45}
              onInit={setRf}
              onNodeClick={(_, n) => {
                setSelNodeId(n.id);
                setSelEdgeId(null);
              }}
              onNodeDoubleClick={onNodeDoubleClick}
              onEdgeClick={(_, e) => {
                setSelEdgeId(e.id);
                setSelNodeId(null);
              }}
              onPaneClick={() => {
                setSelNodeId(null);
                setSelEdgeId(null);
              }}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              colorMode="dark"
              snapToGrid
              snapGrid={[16, 16]}
              fitView
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.6} color="#3a4256" />
              <Controls />
            </ReactFlow>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-gray-500">
              Select or create a script to start building.
            </div>
          )}
          </div>
        </div>

        {/* Configuration drawer — the Lab's full settings, opened via the cog */}
        {configOpen && (
          <div className="flex w-96 shrink-0 flex-col border-l border-gray-800">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-800 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">Configuration</p>
              <button onClick={() => setConfigOpen(false)} title="Close" className="text-gray-500 transition hover:text-gray-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <LabConfigForm onAssistantChange={(id) => setLabAssistantId(id)} />
            </div>
          </div>
        )}

        {/* Config panel */}
        {!configOpen && (sd || selEdge) && (
          <div className="w-72 shrink-0 space-y-3 overflow-y-auto border-l border-gray-800 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                {sd ? (sd.kind === "start" ? "Start call" : `${CONTENT_META[content]?.label ?? "Step"} box`) : "Connection"}
              </p>
              <button onClick={deleteSelected} className="text-[11px] text-rose-400 hover:text-rose-300">
                Delete
              </button>
            </div>

            {/* Node config */}
            {selNode && sd && (
              <>
                <div>
                  <label className="mb-1 block text-xs text-gray-400">Label</label>
                  <input className={inputCls} value={sd.label} onChange={(e) => patchNodeData(selNode.id, { label: e.target.value })} />
                </div>

                {sd.kind === "start" && (
                  <>
                    <div>
                      <label className="mb-1 block text-xs text-gray-400">Opening mode</label>
                      <select
                        className={inputCls + " [color-scheme:dark]"}
                        value={(sd.config.mode as string) ?? "agent_first"}
                        onChange={(e) => patchConfig(selNode.id, { mode: e.target.value })}
                      >
                        <option value="agent_first">Agent speaks first</option>
                        <option value="wait_for_customer">Wait for the customer to speak</option>
                      </select>
                    </div>
                    {((sd.config.mode as string) ?? "agent_first") === "agent_first" && (
                      <div>
                        <label className="mb-1 block text-xs text-gray-400">
                          Opening line <span className="text-gray-600">(this script&rsquo;s own)</span>
                        </label>
                        <textarea
                          className={inputCls + " min-h-[80px] resize-y"}
                          value={(sd.config.opening as string) ?? ""}
                          onChange={(e) => patchConfig(selNode.id, { opening: e.target.value })}
                          placeholder="e.g. Hi {{name}}! This is Alex from the customer team — quick welcome call. Got a moment?"
                        />
                        <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                          {(
                            [
                              ["reword", "Agent rewords it"],
                              ["verbatim", "Exact line"],
                            ] as const
                          ).map(([val, lbl]) => (
                            <button
                              key={val}
                              onClick={() => patchConfig(selNode.id, { openingDelivery: val })}
                              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                                (((sd.config.openingDelivery as string) ?? "verbatim") === val)
                                  ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                                  : "border-gray-700 text-gray-400 hover:bg-gray-800"
                              }`}
                            >
                              {lbl}
                            </button>
                          ))}
                        </div>
                        <p className="mt-1 text-[10px] text-gray-600">
                          Spoken as the very first thing on the call — overrides the global &ldquo;First
                          Message&rdquo; scenario. Use {"{{name}}"} for the client&rsquo;s name. Exact line is spoken
                          word-for-word; Agent rewords it keeps the meaning in the agent&rsquo;s own phrasing.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {/* Reply connectors are managed on the canvas: + on the box adds a
                    dot, and clicking a dot's ARROW picks its reply / removes it. */}

                {sd.kind === "step" && (
                  <>
                    {["scenario", "collection", "send_sms", "end", "transfer"].includes(content) &&
                      (() => {
                        const stmts = (sd.config.statements as string[]) ?? [];
                        const setStmts = (arr: string[]) => patchConfig(selNode.id, { statements: arr });
                        return (
                          <details className="rounded-lg border border-gray-800" open={stmts.length > 0}>
                            <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300">
                              Additional statements ({stmts.length})
                            </summary>
                            <div className="p-2.5">
                            {stmts.map((s, i) => (
                              <div key={i} className="mb-1.5 flex items-start gap-1.5">
                                <textarea
                                  className={inputCls + " min-h-[44px] resize-y"}
                                  value={s}
                                  onChange={(e) => setStmts(stmts.map((x, j) => (j === i ? e.target.value : x)))}
                                  placeholder="e.g. Also — this offer expires Sunday."
                                />
                                <button
                                  onClick={() => setStmts(stmts.filter((_, j) => j !== i))}
                                  className="mt-1 shrink-0 text-sm text-gray-500 hover:text-rose-400"
                                  title="Remove statement"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                            <button
                              onClick={() => setStmts([...stmts, ""])}
                              className="rounded-md border border-dashed border-gray-600 px-2 py-1 text-[11px] text-gray-400 transition hover:border-indigo-500 hover:text-indigo-300"
                            >
                              + Add statement
                            </button>
                            {stmts.length > 0 && (
                              <p className="mt-1 text-[10px] text-gray-600">
                                Spoken with the box&rsquo;s line, in order, inside the SAME single reply.
                              </p>
                            )}
                            </div>
                          </details>
                        );
                      })()}

                    {content === "scenario" && draft && (
                      <>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">
                            Description <span className="text-gray-600">(when does this fit?)</span>
                          </label>
                          <textarea
                            className={inputCls + " min-h-[60px] resize-y"}
                            value={draft.hint}
                            onChange={(e) => patchDraft(selNode.id, draft, { hint: e.target.value })}
                            placeholder="e.g. the customer asks about price"
                          />
                          <p className="mt-1 text-[10px] text-gray-600">
                            Shown on the box, and helps the agent pick this line when the customer goes off script.
                          </p>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">
                            What the agent says <span className="text-gray-600">(write new, or pick an existing scenario)</span>
                          </label>
                          <select
                            className={inputCls + " mb-1.5 [color-scheme:dark]"}
                            value={sd.scenarioId ?? ""}
                            onChange={(e) => pickScenario(selNode.id, e.target.value || null)}
                          >
                            <option value="">(new line for this box)</option>
                            {scenarios.filter((s) => s.action_type !== "ignore").map((s) => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                          </select>
                          <textarea
                            className={inputCls + " min-h-[110px] resize-y"}
                            value={draft.text}
                            onChange={(e) => patchDraft(selNode.id, draft, { text: e.target.value })}
                            placeholder="Type the line for this step — it's saved to the Playbook automatically."
                          />
                          <p className="mt-1 text-[10px] text-gray-600">
                            Picking a scenario shows its line here. Editing the text edits that Playbook scenario — for
                            every script and campaign that uses it. Keep campaign wording in scenarios so scripts stay
                            reusable.
                          </p>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">Delivery</label>
                          <div className="grid grid-cols-2 gap-1.5">
                            {(
                              [
                                ["reword", "Agent rewords it"],
                                ["verbatim", "Exact line"],
                              ] as const
                            ).map(([val, lbl]) => (
                              <button
                                key={val}
                                onClick={() => patchDraft(selNode.id, draft, { delivery: val })}
                                className={`rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                                  draft.delivery === val
                                    ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                                    : "border-gray-700 text-gray-400 hover:bg-gray-800"
                                }`}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 text-[10px] text-gray-600">
                            Agent rewords it is usually best — natural phrasing in context. Keep Exact line for prices,
                            terms, and compliance wording.
                          </p>
                        </div>

                        <details className="rounded-lg border border-gray-800">
                          <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300">
                            Advanced
                          </summary>
                          <div className="space-y-3 p-2.5">
                            <div>
                              <label className="mb-1 block text-xs text-gray-400">
                                Also consider <span className="text-gray-600">(router picks best)</span>
                              </label>
                              {((sd.config.candidateScenarioIds as string[]) ?? []).map((cid) => (
                                <button
                                  key={cid}
                                  onClick={() =>
                                    patchConfig(selNode.id, {
                                      candidateScenarioIds: ((sd.config.candidateScenarioIds as string[]) ?? []).filter((x) => x !== cid),
                                    })
                                  }
                                  className="mb-1 mr-1 inline-flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-300 hover:bg-indigo-500/25"
                                >
                                  {scenarioName(cid) ?? "scenario"} <span className="text-indigo-400">×</span>
                                </button>
                              ))}
                              <select
                                className={inputCls + " [color-scheme:dark]"}
                                value=""
                                onChange={(e) => {
                                  const id = e.target.value;
                                  const cur = (sd.config.candidateScenarioIds as string[]) ?? [];
                                  if (id && id !== sd.scenarioId && !cur.includes(id)) patchConfig(selNode.id, { candidateScenarioIds: [...cur, id] });
                                }}
                              >
                                <option value="">+ add candidate…</option>
                                {scenarios.filter((s) => s.action_type !== "ignore" && s.id !== sd.scenarioId && !((sd.config.candidateScenarioIds as string[]) ?? []).includes(s.id)).map((s) => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="mb-1 block text-xs text-gray-400">
                                Active tags at this step <span className="text-gray-600">(blank = all)</span>
                              </label>
                              <div className="flex flex-wrap gap-1.5">
                                {allTags.map((t) => {
                                  const scope = (sd.config.scopeTags as string[]) ?? [];
                                  const on = scope.includes(t);
                                  return (
                                    <button
                                      key={t}
                                      onClick={() => patchConfig(selNode.id, { scopeTags: on ? scope.filter((x) => x !== t) : [...scope, t] })}
                                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition ${on ? "bg-purple-500/25 text-purple-200" : "border border-gray-700 text-gray-400"}`}
                                    >
                                      {t}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </div>
                        </details>
                      </>
                    )}

                    {content === "collection" && (
                      <>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">Collection <span className="text-gray-600">(the reply picks a member)</span></label>
                          <select
                            className={inputCls + " [color-scheme:dark]"}
                            value={(sd.config.collectionId as string) ?? ""}
                            onChange={(e) => patchConfig(selNode.id, { collectionId: e.target.value || null })}
                          >
                            <option value="">(pick a collection)</option>
                            {collections.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">
                            Replies in this collection <span className="text-gray-600">(answered in place)</span>
                          </label>
                          {(() => {
                            const cid = (sd.config.collectionId as string) ?? "";
                            if (!cid) return <p className="text-[11px] text-gray-600">Pick a collection to see its replies.</p>;
                            const ids = colMembers[cid];
                            if (!ids) return <p className="text-[11px] text-gray-600">Loading…</p>;
                            // Reply-detector matchers are routing plumbing, not content — hidden.
                            const members = scenarios.filter((s) => ids.includes(s.id) && s.action_type !== "ignore");
                            if (!members.length) return <p className="text-[11px] text-gray-600">This collection is empty — add scenarios to it in the Playbook.</p>;
                            return (
                              <ul className="space-y-1">
                                {members.map((s) => (
                                  <li key={s.id} className={`rounded-md bg-gray-900/60 px-2 py-1.5 ${s.enabled ? "" : "opacity-50"}`}>
                                    <p className="flex items-center gap-1.5 text-[11px] font-medium text-gray-300">
                                      <span className="min-w-0 truncate">{s.name}</span>
                                      {!s.enabled && (
                                        <span className="shrink-0 rounded-full bg-gray-700 px-1.5 py-px text-[9px] font-semibold text-gray-400" title="Toggled off in the Playbook — won't be matched on calls">
                                          off
                                        </span>
                                      )}
                                    </p>
                                    {s.description && <p className="mt-0.5 text-[10px] text-gray-500">{snip(s.description, 84)}</p>}
                                  </li>
                                ))}
                              </ul>
                            );
                          })()}
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">
                            When nothing in the collection fits{" "}
                            <span className="text-gray-600">(write a line, use a scenario, or fall back to a collection)</span>
                          </label>
                          <select
                            className={inputCls + " mb-1.5 [color-scheme:dark]"}
                            value={
                              (sd.config.elseCollectionId as string)
                                ? "col:" + (sd.config.elseCollectionId as string)
                                : sd.scenarioId
                                  ? "scn:" + sd.scenarioId
                                  : ""
                            }
                            onChange={(e) => {
                              const v = e.target.value;
                              if (v.startsWith("col:")) {
                                patchConfig(selNode.id, { elseCollectionId: v.slice(4) });
                                pickScenario(selNode.id, null);
                              } else if (v.startsWith("scn:")) {
                                patchConfig(selNode.id, { elseCollectionId: null });
                                pickScenario(selNode.id, v.slice(4));
                              } else {
                                patchConfig(selNode.id, { elseCollectionId: null });
                                pickScenario(selNode.id, null);
                              }
                            }}
                          >
                            <option value="">(write a line below)</option>
                            <optgroup label="Use an existing scenario">
                              {scenarios.filter((s) => s.action_type !== "ignore").map((s) => (
                                <option key={s.id} value={"scn:" + s.id}>{s.name}</option>
                              ))}
                            </optgroup>
                            <optgroup label="Fall back to another collection">
                              {collections.filter((c) => c.id !== (sd.config.collectionId as string)).map((c) => (
                                <option key={c.id} value={"col:" + c.id}>{c.name}</option>
                              ))}
                            </optgroup>
                          </select>
                          {(sd.config.elseCollectionId as string) ? (
                            <p className="rounded-md bg-gray-900/60 p-1.5 text-[10px] text-gray-500">
                              Unmatched replies get a second chance against{" "}
                              <span className="text-gray-300">{collectionName(sd.config.elseCollectionId as string) ?? "that collection"}</span>{" "}
                              — its matching reply is spoken (merged when several fit). Nothing fits there either → the
                              automatic briefing.
                            </p>
                          ) : (
                            draft && (
                              <>
                                <textarea
                                  className={inputCls + " min-h-[80px] resize-y"}
                                  value={draft.text}
                                  onChange={(e) => patchDraft(selNode.id, draft, { text: e.target.value })}
                                  placeholder="e.g. Quick version: you've got free spins waiting on your account — want the link by text?"
                                />
                                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                                  {(
                                    [
                                      ["reword", "Agent rewords it"],
                                      ["verbatim", "Exact line"],
                                    ] as const
                                  ).map(([val, lbl]) => (
                                    <button
                                      key={val}
                                      onClick={() => patchDraft(selNode.id, draft, { delivery: val })}
                                      className={`rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                                        draft.delivery === val
                                          ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                                          : "border-gray-700 text-gray-400 hover:bg-gray-800"
                                      }`}
                                    >
                                      {lbl}
                                    </button>
                                  ))}
                                </div>
                                {sd.scenarioId && (
                                  <button
                                    onClick={() => pickScenario(selNode.id, null)}
                                    className="mt-1.5 text-[11px] text-gray-500 transition hover:text-rose-400"
                                  >
                                    Remove the else line (back to the automatic briefing)
                                  </button>
                                )}
                                <p className="mt-1 text-[10px] text-gray-600">
                                  Leave empty for the automatic briefing. Saved to the Playbook on Save, like any box line.
                                </p>
                              </>
                            )
                          )}
                        </div>
                        <p className="rounded-lg border border-gray-700 bg-gray-900/50 p-2 text-[10px] text-gray-500">
                          Reply order at this box: a matching reply in the collection answers on the spot; nothing
                          fits → the Else scenario speaks; no Else set → the agent gets a short grounding briefing.
                          Add reply connectors (the + on the box) for the replies that should move the call onward.
                        </p>
                      </>
                    )}

                    {content === "subworkflow" && (
                      <div>
                        <label className="mb-1 block text-xs text-gray-400">Sub-workflow <span className="text-gray-600">(another script)</span></label>
                        <select
                          className={inputCls + " [color-scheme:dark]"}
                          value={(sd.config.subworkflowId as string) ?? ""}
                          onChange={(e) => patchConfig(selNode.id, { subworkflowId: e.target.value || null })}
                        >
                          <option value="">(pick a workflow)</option>
                          {scripts.filter((s) => s.id !== scriptId).map((s) => (
                            <option key={s.id} value={s.id}>{s.name}</option>
                          ))}
                        </select>
                        <p className="mt-1 text-[10px] text-gray-600">When it finishes it returns a result; branch the next arrow on that result. Double-click the box on the canvas to preview its flow.</p>
                      </div>
                    )}

                    {content === "send_sms" && draft && (
                      <>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">Confirmation line <span className="text-gray-600">(spoken as the text is sent)</span></label>
                          <textarea
                            className={inputCls + " min-h-[80px] resize-y"}
                            value={draft.text}
                            onChange={(e) => patchDraft(selNode.id, draft, { text: e.target.value })}
                            placeholder="e.g. Perfect — I'm texting you the link right now."
                          />
                          <p className="mt-1 text-[10px] text-gray-600">
                            In the lab the SMS is logged, not actually sent.
                          </p>
                        </div>
                        <details className="rounded-lg border border-gray-800">
                          <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300">
                            Advanced
                          </summary>
                          <div className="p-2.5">
                            <label className="mb-1 block text-xs text-gray-400">Reuse an existing line</label>
                            <select
                              className={inputCls + " [color-scheme:dark]"}
                              value={sd.scenarioId ?? ""}
                              onChange={(e) => pickScenario(selNode.id, e.target.value || null)}
                            >
                              <option value="">(new line for this box)</option>
                              {scenarios.filter((s) => s.action_type !== "ignore").map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </div>
                        </details>
                      </>
                    )}

                    {content === "transfer" && draft && (
                      <>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">Transfer to (phone number)</label>
                          <input className={inputCls} value={(sd.config.number as string) ?? ""} onChange={(e) => patchConfig(selNode.id, { number: e.target.value })} placeholder="+1..." />
                        </div>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">Line to say while transferring</label>
                          <textarea
                            className={inputCls + " min-h-[70px] resize-y"}
                            value={draft.text}
                            onChange={(e) => patchDraft(selNode.id, draft, { text: e.target.value })}
                            placeholder="e.g. Of course — connecting you with a colleague now, one moment."
                          />
                          <p className="mt-1 text-[10px] text-gray-600">
                            Lab note: the line is spoken, but the actual call transfer isn&rsquo;t wired up yet.
                          </p>
                        </div>
                      </>
                    )}

                    {content === "wait" && (
                      <>
                        <p className="rounded-lg border border-gray-700 bg-gray-900/50 p-2 text-[11px] text-gray-500">
                          Listens. The agent says nothing and waits for the customer&rsquo;s reply — reply connectors (green dots)
                          route what they say. If they stay quiet too long, the sky-blue <span className="text-sky-400">silence path</span> fires instead.
                        </p>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">
                            Silence timeout <span className="text-gray-600">(seconds of total quiet before the silence path fires)</span>
                          </label>
                          <input
                            type="number"
                            min={2}
                            max={120}
                            className={inputCls}
                            value={Number(sd.config.waitSeconds) || 8}
                            onChange={(e) => patchConfig(selNode.id, { waitSeconds: Math.min(120, Math.max(2, Number(e.target.value) || 8)) })}
                          />
                        </div>
                        {!connectorsOf(sd.config).some((c) => c.silence) && (
                          <button
                            onClick={() =>
                              patchConfig(selNode.id, {
                                connectors: [
                                  ...connectorsOf(sd.config),
                                  { id: "c:" + crypto.randomUUID(), intentKey: "", silence: true, label: "customer stays silent" },
                                ],
                              })
                            }
                            className="w-full rounded-lg border border-sky-700 px-3 py-1.5 text-xs text-sky-300 transition hover:bg-sky-500/10"
                          >
                            Add silence path
                          </button>
                        )}
                      </>
                    )}

                    {content === "return" && (
                      <div>
                        <label className="mb-1 block text-xs text-gray-400">Result <span className="text-gray-600">(handed back to the parent workflow)</span></label>
                        <input className={inputCls} value={(sd.config.resultName as string) ?? ""} onChange={(e) => patchConfig(selNode.id, { resultName: e.target.value })} placeholder="e.g. qualified" />
                        <p className="mt-1 text-[10px] text-gray-600">The parent can branch its next arrow on this result. Use this (not End Call) as a sub-workflow&rsquo;s normal exit.</p>
                      </div>
                    )}

                    {content === "end" && draft && (
                      <>
                        <div>
                          <label className="mb-1 block text-xs text-gray-400">
                            Goodbye line <span className="text-gray-600">(optional)</span>
                          </label>
                          <textarea
                            className={inputCls + " min-h-[80px] resize-y"}
                            value={draft.text}
                            onChange={(e) => patchDraft(selNode.id, draft, { text: e.target.value })}
                            placeholder="e.g. Thanks for your time today — have a great day!"
                          />
                          <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                            {(
                              [
                                ["reword", "Agent rewords it"],
                                ["verbatim", "Exact line"],
                              ] as const
                            ).map(([val, lbl]) => (
                              <button
                                key={val}
                                onClick={() => patchDraft(selNode.id, draft, { delivery: val })}
                                className={`rounded-md border px-2 py-1.5 text-xs font-medium transition ${
                                  draft.delivery === val
                                    ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
                                    : "border-gray-700 text-gray-400 hover:bg-gray-800"
                                }`}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 text-[10px] text-gray-600">
                            Spoken before hanging up — Exact line word-for-word, Agent rewords it in its own phrasing.
                            Leave blank for the default goodbye.
                          </p>
                        </div>
                        <details className="rounded-lg border border-gray-800">
                          <summary className="cursor-pointer px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300">
                            Advanced
                          </summary>
                          <div className="p-2.5">
                            <label className="mb-1 block text-xs text-gray-400">Reuse an existing line</label>
                            <select
                              className={inputCls + " [color-scheme:dark]"}
                              value={sd.scenarioId ?? ""}
                              onChange={(e) => pickScenario(selNode.id, e.target.value || null)}
                            >
                              <option value="">(new line for this box)</option>
                              {scenarios.filter((s) => s.action_type !== "ignore").map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </div>
                        </details>
                      </>
                    )}

                  </>
                )}
              </>
            )}

            {/* Edge config — a connector arrow carries its reply; others are plain */}
            {selEdge &&
              (() => {
                const c = (selEdge.data as { condition?: { handle?: string; value?: string } } | undefined)?.condition;
                const h = c?.handle;
                if (isConnectorHandle(h)) {
                  const isAny = (c as { kind?: string } | undefined)?.kind === "any";
                  const isTimeout = (c as { kind?: string } | undefined)?.kind === "timeout";
                  const scn = scenarios.find((s) => s.intent_key === c?.value);
                  if (isTimeout) {
                    const srcN = selEdge.source ? nodes.find((n) => n.id === selEdge.source) : undefined;
                    const secs = Number((srcN?.data as NodeData | undefined)?.config.waitSeconds) || 8;
                    return (
                      <>
                        <p className="rounded-lg border border-sky-800 bg-sky-500/5 p-2 text-xs text-gray-300">
                          Silence path
                          <span className="block text-[10px] text-gray-500">
                            Fires when the customer stays completely quiet for {secs}s at this box — no rule needed.
                            Change the seconds on the Wait box itself.
                          </span>
                        </p>
                        <button
                          onClick={() => {
                            if (selEdge.source) removeConnector(selEdge.source, h);
                            setSelEdgeId(null);
                          }}
                          className="w-full rounded-md border border-gray-700 px-2 py-1.5 text-xs text-gray-400 transition hover:border-rose-500 hover:text-rose-300"
                        >
                          Remove the silence path (dot + arrow)
                        </button>
                      </>
                    );
                  }
                  return (
                    <>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-gray-700 bg-gray-900/50 p-2">
                        <input
                          type="checkbox"
                          checked={isAny}
                          onChange={(e) => selEdge.source && setConnectorAny(selEdge.source, h, e.target.checked)}
                          className="mt-0.5 accent-emerald-500"
                        />
                        <span className="text-xs text-gray-300">
                          Any other reply
                          <span className="block text-[10px] text-gray-500">
                            Fires no matter what was said, when no other connector on the box matched.
                          </span>
                        </span>
                      </label>
                      {!isAny && (
                      <>
                      <div>
                        <label className="mb-1 block text-xs text-gray-400">When should the agent use this?</label>
                        <textarea
                          className={inputCls + " min-h-[80px] resize-y"}
                          value={connDescDrafts[h] ?? scn?.description ?? ""}
                          onChange={(e) => setConnDescDrafts((m) => ({ ...m, [h]: e.target.value }))}
                          onBlur={(e) => selEdge.source && saveConnectorRule(selEdge.source, h, e.target.value)}
                          placeholder={'e.g. the customer agrees — "yes", "sure", "okay go ahead"'}
                        />
                        <p className="mt-1 text-[10px] text-gray-600">
                          Describe the customer reply that should send the call down this arrow — same as when
                          creating a scenario. Saved when you click away.
                        </p>
                      </div>
                      <div>
                        <label className="mb-1 block text-xs text-gray-400">
                          Quick match words <span className="text-gray-600">(optional — instant routing)</span>
                        </label>
                        <input
                          className={inputCls}
                          value={(() => {
                            const srcN = selEdge.source ? nodes.find((n) => n.id === selEdge.source) : undefined;
                            return srcN ? connectorsOf((srcN.data as NodeData).config).find((x) => x.id === h)?.quickWords ?? "" : "";
                          })()}
                          onChange={(e) => selEdge.source && setConnectorQuick(selEdge.source, h, e.target.value)}
                          placeholder="yes, yeah, yup, sure, okay"
                        />
                        <p className="mt-1 text-[10px] text-gray-600">
                          A short reply made ONLY of these words takes this arrow with zero thinking time — no
                          router call at all. Leave empty to always use the router.
                        </p>
                      </div>
                      </>
                      )}
                      <button
                        onClick={() => {
                          if (selEdge.source) removeConnector(selEdge.source, h);
                          setSelEdgeId(null);
                        }}
                        className="w-full rounded-md border border-gray-700 px-2 py-1.5 text-xs text-gray-400 transition hover:border-rose-500 hover:text-rose-300"
                      >
                        Remove this connector (dot + arrow)
                      </button>
                      <p className="rounded-lg border border-gray-700 bg-gray-900/50 p-2 text-[10px] text-gray-500">
                        Point it at any box — even one further up, to repeat that step (arrows going back up show as a
                        dashed line). Delete above removes just the arrow; the button removes the dot too.
                      </p>
                    </>
                  );
                }
                return (
                  <p className="rounded-lg border border-gray-700 bg-gray-900/50 p-2 text-[11px] text-gray-400">
                    {h === "then"
                      ? "This is the Then path of an If/Else box."
                      : h === "else"
                        ? "This is the Else (fallback) path of an If/Else box."
                        : h === "loop"
                          ? "This is the Repeat path of a Loop box."
                          : h === "exit"
                            ? "This is the Exit path of a Loop box."
                            : "A legacy default arrow from an older script — new boxes route only through reply connectors. Delete it and draw a connector instead."}
                    <br />
                    <span className="text-gray-600">Use Delete above to remove it.</span>
                  </p>
                );
              })()}
          </div>
        )}
      </div>

      {/* Run history — pick a past call to replay in the dock + on the canvas */}
      {history !== null && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" onClick={() => setHistory(null)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex max-h-[75vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 shadow-2xl"
          >
            <div className="border-b border-gray-800 px-5 py-3">
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Run history</p>
              <p className="text-sm font-bold text-white">{scripts.find((s) => s.id === scriptId)?.name ?? "Script"}</p>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-5 py-3">
              {histBusy && <p className="py-4 text-center text-xs text-gray-500">Loading…</p>}
              {!histBusy && history.length === 0 && (
                <p className="py-4 text-center text-xs text-gray-500">No runs yet — hit ▶ Run to make the first one.</p>
              )}
              {history.map((r) => {
                const endedAt = (nodes.find((n) => n.id === r.current_node_id)?.data as NodeData | undefined)?.label;
                return (
                  <button
                    key={r.call_id}
                    onClick={() => viewRun(r)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900/50 px-3 py-2 text-left transition hover:border-gray-600 hover:bg-gray-900"
                  >
                    <span className="min-w-0">
                      <span className="block text-xs font-medium text-gray-200">
                        {new Date(r.updated_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="block truncate text-[10px] text-gray-500">
                        {endedAt ? `reached “${endedAt}”` : "position unknown (boxes changed since)"} · {r.turns ?? 0} turn{(r.turns ?? 0) === 1 ? "" : "s"} · {r.call_id.slice(0, 8)}…
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] font-semibold text-emerald-400">Replay →</span>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end border-t border-gray-800 px-5 py-3">
              <button onClick={() => setHistory(null)} className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pre-flight QA results — gate before a test call can start */}
      {qa && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" onClick={() => setQa(null)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 shadow-2xl"
          >
            <div className="border-b border-gray-800 px-5 py-3">
              <p className="text-[10px] uppercase tracking-wider text-gray-500">Workflow check</p>
              <p className="text-sm font-bold text-white">
                {qa.errors.length + qa.warnings.length > 0
                  ? `${qa.errors.length + qa.warnings.length} issue${qa.errors.length + qa.warnings.length > 1 ? "s" : ""} to fix before the test call`
                  : "All checks passed"}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-3">
              {qa.errors.map((i, k) => (
                <div key={"e" + k} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
                  <p className="text-xs text-rose-300">{i.text}</p>
                  {i.suggestion && <p className="mt-0.5 text-[11px] text-rose-400/70">→ {i.suggestion}</p>}
                </div>
              ))}
              {qa.warnings.map((i, k) => (
                <div key={"w" + k} className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <p className="text-xs text-amber-300">{i.text}</p>
                  {i.suggestion && <p className="mt-0.5 text-[11px] text-amber-400/70">→ {i.suggestion}</p>}
                </div>
              ))}
              {!qa.errors.length && !qa.warnings.length && (
                <p className="py-4 text-center text-sm text-gray-400">
                  Every box has a line, every connector has a rule and an arrow, and the call can reach the end.
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-gray-800 px-5 py-3">
              <button onClick={() => setQa(null)} className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">
                Close
              </button>
              <button
                onClick={startRun}
                disabled={qa.errors.length > 0 || qa.warnings.length > 0 || qaBusy}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
                title={
                  qa.errors.length + qa.warnings.length > 0
                    ? "Fix every issue above first — the call only starts on a clean check"
                    : "Start a live test call from the browser"
                }
              >
                Start test call
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sub-workflow preview (read-only) */}
      {preview && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" onClick={() => setPreview(null)}>
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex h-[80vh] w-[85vw] max-w-5xl flex-col overflow-hidden rounded-2xl border border-gray-700 bg-gray-950 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-gray-800 px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-gray-500">Sub-workflow preview</p>
                <p className="truncate text-sm font-bold text-white">{preview.name}</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    const id = preview.id;
                    setPreview(null);
                    loadScript(id);
                  }}
                  className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800"
                >
                  Open for editing
                </button>
                <button onClick={() => setPreview(null)} className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800">
                  Close
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              <ReactFlow
                nodes={preview.nodes}
                edges={preview.edges}
                nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
                colorMode="dark"
                fitView
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable={false}
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={18} size={1.6} color="#3a4256" />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
