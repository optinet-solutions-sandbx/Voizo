import { describe, expect, it } from "vitest";
import { decideScriptSeed } from "./resolveScript";

const camp = (
  id: string,
  scriptId: string | null,
  agentMode: string | null = "script"
) => ({ id, script_id: scriptId, agent_mode: agentMode });

describe("decideScriptSeed", () => {
  it("one script campaign holding the clone → seed with its script", () => {
    const d = decideScriptSeed([camp("c1", "s1")]);
    expect(d).toEqual({ kind: "seed", scriptId: "s1", campaignId: "c1" });
  });

  it("multiple campaigns sharing ONE script (recurring children) → still seed, not ambiguous", () => {
    const d = decideScriptSeed([camp("c1", "s1"), camp("c2", "s1")]);
    expect(d.kind).toBe("seed");
    expect(d.kind === "seed" && d.scriptId).toBe("s1");
  });

  it("two campaigns with DIFFERENT scripts on one assistantId → ambiguous, never guesses", () => {
    const d = decideScriptSeed([camp("c1", "s1"), camp("c2", "s2")]);
    expect(d).toEqual({
      kind: "ambiguous",
      scriptIds: ["s1", "s2"],
      campaignIds: ["c1", "c2"],
    });
  });

  it("non-script campaigns and null script_ids are ignored", () => {
    expect(decideScriptSeed([camp("c1", "s1", "assistant")])).toEqual({ kind: "none" });
    expect(decideScriptSeed([camp("c1", null)])).toEqual({ kind: "none" });
    expect(decideScriptSeed([])).toEqual({ kind: "none" });
  });

  it("mixed: one script campaign among assistant-mode rows → seed from the script one", () => {
    const d = decideScriptSeed([camp("legacy", "sX", "assistant"), camp("c9", "s9")]);
    expect(d).toEqual({ kind: "seed", scriptId: "s9", campaignId: "c9" });
  });
});
