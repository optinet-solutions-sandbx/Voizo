// Guards on VOIZO_SYSTEM_PREFIX — the dev-controlled instructions prepended to
// every clone's prompt. Rule #1 (SMS handling, v2 2026-06-11): the verbal
// dispatch confirmation ("I'll send you an SMS now") is the announce signal the
// webhook's mode-aware dispatch keys on (agentMentionedSms / consent window),
// an explicit customer objection must always veto, and the rule must claim
// precedence over conflicting base-script lines (Val/STEVIC bases carry
// announce-after-refusal wording). The earlier ask-first variant was reverted
// per the client's registration-opt-in direction (Val, 2026-06-11).
import { afterEach, describe, expect, it, vi } from "vitest";
import { VOIZO_SYSTEM_PREFIX, createClone } from "./cloneAssistant";
import {
  agentMentionedSms, customerDeclinedSms, hasGenuineCustomerConsent,
} from "../transcriptClassify";

describe("VOIZO_SYSTEM_PREFIX — SMS handling rule (#1)", () => {
  it("keeps the hand-synced first-line sentinel (promptVersionData.VOIZO_PREFIX_SENTINEL)", () => {
    expect(VOIZO_SYSTEM_PREFIX.split("\n")[0]).toBe("[System Instructions — Voizo Platform]");
  });

  it("requires the verbal dispatch confirmation", () => {
    expect(VOIZO_SYSTEM_PREFIX).toMatch(/verbally confirm/i);
    expect(VOIZO_SYSTEM_PREFIX).toContain(`"I'll send you an SMS now"`);
  });

  it("has an explicit objection veto — accept the no, never pressure", () => {
    expect(VOIZO_SYSTEM_PREFIX).toMatch(/objects to being texted/i);
    expect(VOIZO_SYSTEM_PREFIX).toMatch(/do NOT promise or send an SMS/);
    expect(VOIZO_SYSTEM_PREFIX).toMatch(/accept that answer the FIRST/);
    expect(VOIZO_SYSTEM_PREFIX).toMatch(/never pressure/i);
  });

  it("claims precedence over conflicting base-script lines", () => {
    expect(VOIZO_SYSTEM_PREFIX).toMatch(/follow THIS rule/);
  });

  it("rule #1's confirmation phrase is the announce signal the webhook dispatch keys on", () => {
    const confirmTurn = `AI: I'll send you an SMS now.`;
    // registered_optin mode: the announce alone arms dispatch…
    expect(agentMentionedSms(`${confirmTurn}\nUser: Okay, thanks.`)).toBe(true);
    // …an explicit refusal vetoes it…
    expect(customerDeclinedSms(`${confirmTurn}\nUser: Please don't text me.`)).toBe(true);
    // …and in verbal_yes mode the same phrase opens the consent window for a yes.
    expect(hasGenuineCustomerConsent(`${confirmTurn}\nUser: Okay, thanks.`)).toBe(true);
  });

  it("keeps rules 2–4 and the end marker intact", () => {
    expect(VOIZO_SYSTEM_PREFIX).toContain("2. CALL ENDING");
    expect(VOIZO_SYSTEM_PREFIX).toContain("3. OPT-OUT");
    expect(VOIZO_SYSTEM_PREFIX).toContain("4. NOT A REAL PERSON");
    expect(VOIZO_SYSTEM_PREFIX).toContain("[End System Instructions]");
  });

  it("stays a small fixed overhead on the 20k agent-prompt budget", () => {
    expect(VOIZO_SYSTEM_PREFIX.length).toBeLessThan(3000);
  });
});

// ── VOZ-128: clones must inherit the base's tuned turn-taking phrase lists.
// acknowledgementPhrases / interruptionPhrases live INSIDE stopSpeakingPlan, so
// the VOIZO_RUNTIME_POLICY floor has to MERGE over them, not replace the object.
describe("createClone — stopSpeakingPlan phrase-list preservation (VOZ-128)", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Stub Vapi: GET base -> `base`; POST /assistant -> capture the body, return a clone.
  type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  function stubVapi(base: Record<string, unknown>) {
    const posted: { body: unknown } = { body: null };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<FakeRes> => {
      if (init?.method === "POST") {
        posted.body = JSON.parse(String(init.body));
        return { ok: true, status: 200, json: async () => ({ id: "clone_1", name: "n" }), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => base, text: async () => "" };
    });
    vi.stubGlobal("fetch", fetchMock);
    return posted;
  }
  const ssp = (p: { body: unknown }) =>
    (p.body as { stopSpeakingPlan: Record<string, unknown> }).stopSpeakingPlan;

  const VAL_SSP = {
    numWords: 3,
    backoffSeconds: 1,
    acknowledgementPhrases: ["okay", "yeah", "right", "are you there"],
    interruptionPhrases: ["stop", "wait", "hold on"],
  };

  it("preserves base phrase lists while the Voizo floor still wins on the knobs", async () => {
    const posted = stubVapi({ name: "Val", stopSpeakingPlan: VAL_SSP, model: { messages: [] } });
    const res = await createClone("k", "base_val", {});
    expect(res.ok).toBe(true);
    // phrase lists survive verbatim…
    expect(ssp(posted).acknowledgementPhrases).toEqual(VAL_SSP.acknowledgementPhrases);
    expect(ssp(posted).interruptionPhrases).toEqual(VAL_SSP.interruptionPhrases);
    // …and the runtime floor still owns numWords / voiceSeconds / backoffSeconds.
    expect(ssp(posted).numWords).toBe(2);
    expect(ssp(posted).voiceSeconds).toBe(0.3);
    expect(ssp(posted).backoffSeconds).toBe(1);
  });

  it("is byte-identical to the bare floor for a base with no stopSpeakingPlan", async () => {
    const posted = stubVapi({ name: "Ernie", model: { messages: [] } });
    const res = await createClone("k", "base_ernie", {});
    expect(res.ok).toBe(true);
    expect(ssp(posted)).toEqual({ numWords: 2, voiceSeconds: 0.3, backoffSeconds: 1 });
  });

  it("does not leak base phrases into a script-mode clone (engine owns stopSpeakingPlan)", async () => {
    const posted = stubVapi({ name: "Val", stopSpeakingPlan: VAL_SSP, model: { messages: [] } });
    const res = await createClone("k", "base_val", {
      scriptClone: {
        composedPrompt: "SCRIPT",
        firstMessage: null,
        firstMessageMode: null,
        serverMessages: [],
        stopSpeakingPlan: { numWords: 1 }, // engine's own value
        startSpeakingPlan: {},
        messagePlan: {},
        monitorPlan: {},
        transcriberKeyterms: [],
        noTools: true,
      },
    });
    expect(res.ok).toBe(true);
    // engine value wins (it spreads after the VOZ-128 merge); base phrases absent.
    expect(ssp(posted)).toEqual({ numWords: 1 });
    expect(ssp(posted).acknowledgementPhrases).toBeUndefined();
  });
});
