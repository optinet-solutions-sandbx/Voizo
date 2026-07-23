// Workstream E (VOZ-116 unblock): the shared allow-list for the /api/lab/db
// RPC dispatcher. Pure module (no IO) — imported by the server route (to gate
// dispatch) and the browser shim (to generate its wrappers), so the browser
// surface is defined in exactly one place.
//
// These are the ONLY lab-db functions the Builder UIs may call remotely.
// Everything else on the module (and anything off the prototype chain) is
// rejected — lookups go through a Set, never bare object indexing.
export const LAB_DB_BROWSER_FNS = [
  // scripts
  "listScripts",
  "createScript",
  "updateScript",
  "deleteScript",
  "duplicateScript",
  "getScriptGraph",
  "saveScriptGraph",
  // handlers (Playbook)
  "listHandlers",
  "createHandler",
  "updateHandler",
  "deleteHandler",
  "duplicateHandler",
  // collections
  "listCollections",
  "createCollection",
  "updateCollection",
  "deleteCollection",
  "duplicateCollection",
  "getCollectionHandlerIds",
  "setCollectionHandlers",
  // settings
  "getLabSettings",
  "saveLabSettings",
  // run dock (live test-call view)
  "getFlowState",
  "listLabCallEvents",
  "listScriptRuns",
  "utteranceCounts",
  "insertLabEvent",
] as const;

export type LabDbBrowserFn = (typeof LAB_DB_BROWSER_FNS)[number];

const ALLOWED = new Set<string>(LAB_DB_BROWSER_FNS);

export function isAllowedLabDbFn(fn: string): fn is LabDbBrowserFn {
  return ALLOWED.has(fn);
}
