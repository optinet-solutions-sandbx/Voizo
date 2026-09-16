import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// ── VOZ-523: the wizard's voicemail-auto-hangup toggle must only ever write OFF ──
//
// The toggle is defaulted ON because campaigns_v2.voicemail_autohangup has
// defaulted to TRUE since 2026-09-11. Leaving it alone must therefore send NO
// key at all, so a create is byte-identical to one made before this control
// existed. The tempting "simplification" —
//
//     voicemailAutohangup: state.voicemailAutohangup
//
// — type-checks, looks more honest, and leaves the whole suite green, but it
// starts passing `true` on every Fixed create. That trips createCampaignV2's
// `input.voicemailAutohangup === true` branch (campaignV2Data.ts:210), which
// GETs and PATCHes the freshly-cloned Vapi assistant. liveCallControl.ts:136
// warns that when the assistant carries no serverMessages field, that PATCH
// REPLACES Vapi's implicit default set with an explicit minimal list — never
// reviewed against a non-Val base, and the wizard lets an operator pick any base.
//
// Source-level for the same reason as pauseReleasesSlotSites.test.ts: wizardState.ts
// carries runtime `@/` imports this alias-less harness cannot resolve, so
// buildCreateInput is not importable here (see the header of this file).
const WIZARD_STATE = "src/app/campaigns/v2/new/wizardState.ts";

/** The body of buildCreateInput — from its signature to the next top-level `export`. */
function buildCreateInputBody(src: string): string {
  const start = src.indexOf("export function buildCreateInput");
  if (start < 0) return "";
  const rest = src.slice(start + 1);
  const end = rest.indexOf("\nexport ");
  return end < 0 ? rest : rest.slice(0, end);
}

/** Non-comment lines mentioning the flag, which is what actually ships. */
function flagLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .filter((l) => l.includes("voicemailAutohangup"))
    .filter((l) => {
      const t = l.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    });
}

const GUARDED = "...(state.voicemailAutohangup ? {} : { voicemailAutohangup: false })";

describe("VOZ-523: buildCreateInput writes voicemailAutohangup only to turn it OFF", () => {
  const src = readFileSync(join(process.cwd(), WIZARD_STATE), "utf8");
  const body = buildCreateInputBody(src);
  const lines = flagLines(body);

  it("finds the flag in both branches (recurring + fixed)", () => {
    // A vacuous pass is worse than a failure: if the field is renamed or the
    // function reshaped, every assertion below succeeds while asserting nothing.
    expect(
      body.length,
      `buildCreateInput not found in ${WIZARD_STATE} — the matcher is stale.`,
    ).toBeGreaterThan(0);
    expect(
      lines.length,
      `expected voicemailAutohangup in BOTH buildCreateInput branches of ${WIZARD_STATE}, ` +
        `found ${lines.length}. A branch that omits it silently loses the operator's choice.`,
    ).toBe(2);
  });

  it("every write is the guarded spread, never an unconditional key", () => {
    for (const l of lines) {
      expect(
        l.includes(GUARDED),
        `${WIZARD_STATE} writes voicemailAutohangup unconditionally:\n  ${l.trim()}\n` +
          `Use \`${GUARDED}\`. Passing true fires createCampaignV2's Vapi assistant ` +
          `PATCH (campaignV2Data.ts:210) on every create — see this block's header.`,
      ).toBe(true);
    }
  });

  it("known-bad control: the unconditional form is actually rejected", () => {
    // Without this, a matcher that silently matches nothing would pass forever.
    const mutated = body.replaceAll(GUARDED, "voicemailAutohangup: state.voicemailAutohangup");
    const bad = flagLines(mutated);
    expect(bad).toHaveLength(2);
    expect(bad.every((l) => l.includes(GUARDED))).toBe(false);
  });
});
