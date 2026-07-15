import { describe, expect, it } from "vitest";
import { LAB_DB_BROWSER_FNS, isAllowedLabDbFn } from "./lab-db-rpc";

// Workstream E: the /api/lab/db dispatcher may only ever call the exact
// lab-db functions the Builder UIs use — nothing else on the module, and
// nothing off the prototype chain.
describe("lab-db RPC allow-list", () => {
  it("covers the exact browser surface (24 functions)", () => {
    expect(LAB_DB_BROWSER_FNS.length).toBe(24);
    for (const fn of [
      "listScripts", "createScript", "updateScript", "deleteScript", "duplicateScript",
      "getScriptGraph", "saveScriptGraph",
      "listHandlers", "createHandler", "updateHandler", "deleteHandler",
      "listCollections", "createCollection", "updateCollection", "deleteCollection",
      "getCollectionHandlerIds", "setCollectionHandlers",
      "getLabSettings", "saveLabSettings",
      "getFlowState", "listLabCallEvents", "listScriptRuns", "utteranceCounts",
      "insertLabEvent",
    ]) {
      expect(isAllowedLabDbFn(fn), `${fn} should be allowed`).toBe(true);
    }
  });

  it("rejects anything outside the surface", () => {
    for (const fn of ["dropAllTables", "supabase", "eval", ""]) {
      expect(isAllowedLabDbFn(fn), `${fn} must be rejected`).toBe(false);
    }
  });

  it("rejects prototype-chain names (lookup is by Set, not object access)", () => {
    for (const fn of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(isAllowedLabDbFn(fn), `${fn} must be rejected`).toBe(false);
    }
  });
});
