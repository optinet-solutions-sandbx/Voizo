// Request body for POST /api/vapi/clone-assistant (Fixed path only).
// Lives in its own PURE module (type-only import — erased at runtime) so the
// alias-less vitest harness can lock the request contract without evaluating
// wizardState.ts's runtime `@/` import graph.
import type { WizardState } from "./wizardState";

export function buildCloneRequest(state: WizardState) {
  // VOZ-160 script mode: the route clones the designated script-base assistant
  // and composes the prompt from scriptId; persona is saved as system_prompt.
  // VOZ-168-lite: an operator-picked base agent OPTIONALLY rides along — the
  // route resolves `baseAssistantId || VAPI_SCRIPT_BASE_ASSISTANT_ID`, so an
  // unpicked base (property absent) is byte-identical to the pre-feature
  // request. The base supplies the VOICE + call config; the script still
  // decides everything that's said.
  if (state.agentMode === "script") {
    return {
      agentMode: "script" as const,
      scriptId: state.scriptId,
      scriptName: state.scriptName || undefined,
      persona: state.persona || undefined,
      campaignName: state.name.trim(),
      ...(state.vapiAssistantId.trim() ? { baseAssistantId: state.vapiAssistantId.trim() } : {}),
    };
  }
  return {
    baseAssistantId: state.vapiAssistantId.trim(),
    voiceId: state.voiceId || undefined,         // R3: state.voiceId is "" in practice
    systemPrompt: state.systemPrompt || undefined,
    campaignName: state.name.trim(),
  };
}
