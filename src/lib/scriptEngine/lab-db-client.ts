// Browser-side lab-db (workstream E, VOZ-116): the same 26 functions the
// Builder UIs always called, with identical signatures — but each one is a
// thin POST to the Basic-Auth-gated /api/lab/db RPC instead of a direct
// anon-key Supabase read. Type-locked to the real lab-db via `typeof import`,
// which is type-only and pulls NO server runtime into the client bundle.
import type { LabDbBrowserFn } from "./lab-db-rpc";

type LabDb = typeof import("./lab-db");

async function rpc(fn: LabDbBrowserFn, args: unknown[]): Promise<unknown> {
  const r = await fetch("/api/lab/db", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fn, args }),
  });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error(body?.error ?? `lab-db ${fn} failed (${r.status})`);
  return body?.data ?? null;
}

// Each wrapper keeps the exact lab-db signature — call sites don't change.
function remote<K extends LabDbBrowserFn & keyof LabDb>(fn: K): LabDb[K] {
  return ((...args: unknown[]) => rpc(fn, args)) as LabDb[K];
}

// scripts
export const listScripts = remote("listScripts");
export const createScript = remote("createScript");
export const updateScript = remote("updateScript");
export const deleteScript = remote("deleteScript");
export const duplicateScript = remote("duplicateScript");
export const getScriptGraph = remote("getScriptGraph");
export const saveScriptGraph = remote("saveScriptGraph");
// handlers (Playbook)
export const listHandlers = remote("listHandlers");
export const createHandler = remote("createHandler");
export const updateHandler = remote("updateHandler");
export const deleteHandler = remote("deleteHandler");
export const duplicateHandler = remote("duplicateHandler");
// collections
export const listCollections = remote("listCollections");
export const createCollection = remote("createCollection");
export const updateCollection = remote("updateCollection");
export const deleteCollection = remote("deleteCollection");
export const duplicateCollection = remote("duplicateCollection");
export const getCollectionHandlerIds = remote("getCollectionHandlerIds");
export const setCollectionHandlers = remote("setCollectionHandlers");
// settings
export const getLabSettings = remote("getLabSettings");
export const saveLabSettings = remote("saveLabSettings");
// run dock (live test-call view)
export const getFlowState = remote("getFlowState");
export const listLabCallEvents = remote("listLabCallEvents");
export const listScriptRuns = remote("listScriptRuns");
export const utteranceCounts = remote("utteranceCounts");
export const insertLabEvent = remote("insertLabEvent");
