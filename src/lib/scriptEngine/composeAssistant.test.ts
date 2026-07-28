import { describe, it, expect, beforeEach, vi } from "vitest";

// Greet-by-name Ramp 3 (2026-07-18): clone-time token hygiene.
//
// composeScriptClone bakes firstMessage + the entry-stage briefing + the
// standing-answers bank + the persona into the ONE assistant every player in a
// campaign shares. None of those go through substituteVars at run time, so any
// {{token}} left in them would be SPOKEN literally on a live call. This suite
// pins that no author/operator token survives into the shared clone — while the
// legacy {{name}} -> "there" generic greeting is preserved and token-free
// scripts are untouched.
//
// Collaborators are mocked so the test targets composeScriptClone's OWN
// hygiene, not the briefing compilers (covered by their own tests): the graph
// (getScriptGraph) and the two compiled banks (compileStageBriefing /
// compileStandingAnswers) are fed as controlled inputs; the pure lab-flow
// (findEntryNode) and lab-tools (rule constants) run for real.

const m = vi.hoisted(() => ({
  opening: "" as string,
  openingDelivery: undefined as string | undefined,
  entryBriefing: null as string | null,
  standing: null as string | null,
}));

vi.mock("./lab-db", () => ({
  getScriptGraph: vi.fn(async () => ({
    nodes: [
      {
        id: "start",
        type: "start",
        label: "Start",
        config: { opening: m.opening, openingDelivery: m.openingDelivery },
      },
    ],
    edges: [],
  })),
  listHandlers: vi.fn(async () => []),
}));

vi.mock("./lab-briefing", () => ({
  compileStageBriefing: vi.fn(async () => m.entryBriefing),
  compileStandingAnswers: vi.fn(async () => m.standing),
}));

import { composeScriptClone, SCRIPT_RULES } from "./composeAssistant";
import { END_CALL_PHRASES } from "../vapi/cloneAssistant";

beforeEach(() => {
  m.opening = "";
  m.openingDelivery = undefined;
  m.entryBriefing = null;
  m.standing = null;
});

describe("composeScriptClone — clone-time token hygiene (Ramp 3)", () => {
  it("strips an unresolved {{playerName}} from the verbatim firstMessage", async () => {
    m.opening = "Hi {{playerName}}, it's Tom from Lucky Seven.";
    const cfg = await composeScriptClone({ scriptId: "s1", persona: "You are Tom." });
    expect(cfg.firstMessage).not.toContain("{{");
    expect(cfg.firstMessage).toBe("Hi, it's Tom from Lucky Seven.");
    expect(cfg.firstMessageMode).toBe("assistant-speaks-first");
  });

  it("strips an unresolved {{playerName}} from the reworded [Opening] rule", async () => {
    m.opening = "Hi {{playerName}}, quick question for you?";
    m.openingDelivery = "reword";
    const cfg = await composeScriptClone({ scriptId: "s1", persona: "You are Tom." });
    expect(cfg.firstMessage).toBeNull();
    expect(cfg.firstMessageMode).toBe("assistant-speaks-first-with-model-generated-message");
    expect(cfg.composedPrompt).toContain("[Opening]");
    expect(cfg.composedPrompt).not.toContain("{{");
  });

  it("strips tokens from the entry-stage briefing shipped in the prompt, keeping newlines", async () => {
    m.opening = "Hi there.";
    m.entryBriefing = "[CURRENT STAGE]\n  - Greet {{playerName}} warmly\n  - next option";
    const cfg = await composeScriptClone({ scriptId: "s1", persona: "You are Tom." });
    expect(cfg.composedPrompt).not.toContain("{{");
    // token gone + mid-line seam tidied, but the bullet menu's newlines survive
    expect(cfg.composedPrompt).toContain("- Greet warmly");
    expect(cfg.composedPrompt).toContain("\n  - next option");
  });

  it("strips tokens from the standing-answers bank shipped in the prompt", async () => {
    m.opening = "Hi there.";
    m.standing = "[STANDING ANSWERS]\n- Reassure {{playerName}} kindly.";
    const cfg = await composeScriptClone({ scriptId: "s1", persona: "You are Tom." });
    expect(cfg.composedPrompt).not.toContain("{{");
    expect(cfg.composedPrompt).toContain("- Reassure kindly.");
  });

  it("strips tokens from the operator persona", async () => {
    const cfg = await composeScriptClone({
      scriptId: "s1",
      persona: "You are Tom, calling {{playerName}} personally.",
    });
    expect(cfg.composedPrompt).not.toContain("{{");
    expect(cfg.composedPrompt).toContain("calling personally.");
  });

  it("preserves the legacy {{name}} -> \"there\" generic greeting", async () => {
    m.opening = "Hello {{name}}, welcome!";
    const cfg = await composeScriptClone({ scriptId: "s1" });
    expect(cfg.firstMessage).toBe("Hello there, welcome!");
  });

  it("leaves a token-free opening exactly as authored", async () => {
    m.opening = "Hey, it's Tom from Lucky Seven — got a sec?";
    const cfg = await composeScriptClone({ scriptId: "s1" });
    expect(cfg.firstMessage).toBe("Hey, it's Tom from Lucky Seven — got a sec?");
  });
});

// Machine guard (VOZ-245). Script mode does NOT prepend VOIZO_SYSTEM_PREFIX, so
// agent mode's rule #4 (voicemail/intercept -> end the call) was simply missing:
// measured 2026-07-28, script agents pitched into answering machines for a median
// 98s vs 30s in agent mode, and voicemail was 77% of Vapi spend.
describe("composeScriptClone — machine guard (VOZ-245)", () => {
  it("ships the machine rule in every composed prompt", async () => {
    const cfg = await composeScriptClone({ scriptId: "s1", persona: "You are Tom." });
    expect(cfg.composedPrompt).toContain("NOT A LIVE PERSON");
    // The rule must outrank the stage, or SCRIPT_RULES #8 ("the NEWEST stage
    // alone governs") would let a stage briefing talk over it.
    expect(cfg.composedPrompt).toContain("outranks the stage in hand");
  });

  it("covers the greetings that actually answered our calls", async () => {
    const cfg = await composeScriptClone({ scriptId: "s1" });
    // Sampled from the 168 real voicemails in the 07-27/28 run, including the
    // AU "message bank" wording and the cases the conclusive-kill tier
    // deliberately will NOT fire on (a live receptionist could say them).
    for (const phrase of ["message bank", "record your name", "after the tone", "you've reached", "not in service"]) {
      expect(cfg.composedPrompt).toContain(phrase);
    }
  });

  it("PINS the hangup phrase to createClone's END_CALL_PHRASES", () => {
    // Script clones ship noTools:true, so the model cannot call endCall — the
    // ONLY hangup lever is speaking a phrase Vapi recognises. Verified live via
    // endedReason="assistant-said-end-call-phrase". If someone prunes "goodbye"
    // from END_CALL_PHRASES, rule 10 becomes a no-op and script mode silently
    // monologues into voicemail again — so fail here instead.
    const instructed = SCRIPT_RULES.match(/Say exactly one word, "([^"]+)"/);
    expect(instructed).not.toBeNull();
    const spoken = instructed![1].replace(/[.?!]+$/, "").toLowerCase();
    expect(END_CALL_PHRASES).toContain(spoken);
  });
});
