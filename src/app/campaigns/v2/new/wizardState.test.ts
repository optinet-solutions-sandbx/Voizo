import { describe, expect, it } from "vitest";
import { buildCloneRequest } from "./cloneRequest";
import type { WizardState } from "./wizardState";

// VOZ-168-lite: script mode may carry an OPTIONAL operator-picked base agent.
// The clone route already resolves `baseAssistantId || VAPI_SCRIPT_BASE_ASSISTANT_ID`
// — the wizard just has to send the pick. Unpicked must stay byte-identical to
// the pre-feature request (property ABSENT, not undefined), so the env-base
// default path is provably untouched.
//
// buildCloneRequest lives in cloneRequest.ts (pure, type-only import of
// WizardState) because wizardState.ts itself carries runtime `@/` imports the
// alias-less vitest harness can't resolve. Only the fields the builder reads
// are populated; the cast documents that.
const state = (over: Partial<WizardState>): WizardState =>
  ({
    agentMode: "assistant",
    vapiAssistantId: "",
    voiceId: "",
    systemPrompt: "",
    persona: "",
    scriptId: "",
    scriptName: "",
    name: "camp",
    ...over,
  }) as unknown as WizardState;

describe("buildCloneRequest — script-mode base agent (VOZ-168)", () => {
  const script = { agentMode: "script" as const, scriptId: "s1", scriptName: "Val - 20FS + 300% DB" };

  it("no base picked → request has NO baseAssistantId (route falls back to env base)", () => {
    const req = buildCloneRequest(state({ ...script, vapiAssistantId: "" })) as Record<string, unknown>;
    expect(req).not.toHaveProperty("baseAssistantId");
    expect(req.agentMode).toBe("script");
    expect(req.scriptId).toBe("s1");
  });

  it("base picked → baseAssistantId rides the script request", () => {
    const req = buildCloneRequest(state({ ...script, vapiAssistantId: "asst-val-123" })) as Record<string, unknown>;
    expect(req.baseAssistantId).toBe("asst-val-123");
    expect(req.agentMode).toBe("script");
  });

  it("agent mode is unchanged: trimmed baseAssistantId, no script fields", () => {
    const req = buildCloneRequest(state({ vapiAssistantId: " a1 " })) as Record<string, unknown>;
    expect(req.baseAssistantId).toBe("a1");
    expect(req).not.toHaveProperty("scriptId");
  });
});
