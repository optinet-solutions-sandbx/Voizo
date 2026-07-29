// Guards on VOIZO_SYSTEM_PREFIX — the dev-controlled instructions prepended to
// every clone's prompt. Rule #1 (SMS handling, v2 2026-06-11): the verbal
// dispatch confirmation ("I'll send you an SMS now") is the announce signal the
// webhook's mode-aware dispatch keys on (agentMentionedSms / consent window),
// an explicit customer objection must always veto, and the rule must claim
// precedence over conflicting base-script lines (Val/STEVIC bases carry
// announce-after-refusal wording). The earlier ask-first variant was reverted
// per the client's registration-opt-in direction (Val, 2026-06-11).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VOIZO_SYSTEM_PREFIX, createClone, ensureCloneVoice,
  diffBaseAgainstPin, diffCloneAgainstPayload,
} from "./cloneAssistant";
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

// ── VOZ-254: the drift self-heal must MERGE over the clone's existing voice.
// A wholesale { provider, voiceId } PATCH body drops the tuned knobs (model,
// speed, optimizeStreamingLatency) — the same nested-object mistake VOZ-128
// fixed for stopSpeakingPlan. These tests are the pin: reintroduce the replace
// and the first one fails loudly instead of the agent quietly sounding wrong.
describe("ensureCloneVoice — re-patch preserves voice tuning (VOZ-254)", () => {
  afterEach(() => vi.unstubAllGlobals());

  type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
  const STEPHEN = "3jR9BuQAOPMWUjWpi0ll";
  const HOPE = "OYTbf65OHHFELVut7v2H";
  const TUNED = {
    provider: "11labs",
    model: "eleven_turbo_v2_5",
    speed: 1.1,
    optimizeStreamingLatency: 2,
    voiceId: HOPE, // drifted
  };

  // Stateful Vapi stub: GET returns the current voice; PATCH records the body and
  // becomes the new state, so the function's own re-read verifies alignment.
  function stubVapi(voice: Record<string, unknown> | undefined) {
    const state: { voice: Record<string, unknown> | undefined } = { voice };
    const patched: { body: unknown } = { body: null };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit): Promise<FakeRes> => {
      if (init?.method === "PATCH") {
        patched.body = JSON.parse(String(init.body));
        state.voice = (patched.body as { voice: Record<string, unknown> }).voice;
        return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
      }
      return { ok: true, status: 200, json: async () => ({ voice: state.voice }), text: async () => "" };
    }));
    return patched;
  }
  const sentVoice = (p: { body: unknown }) =>
    (p.body as { voice: Record<string, unknown> }).voice;

  it("swaps only voiceId and keeps model / speed / optimizeStreamingLatency", async () => {
    const patched = stubVapi({ ...TUNED });
    const res = await ensureCloneVoice("k", "clone_1", STEPHEN);
    expect(sentVoice(patched).voiceId).toBe(STEPHEN);
    expect(sentVoice(patched).model).toBe("eleven_turbo_v2_5");
    expect(sentVoice(patched).speed).toBe(1.1);
    expect(sentVoice(patched).optimizeStreamingLatency).toBe(2);
    expect(res).toEqual({ aligned: true, actual: STEPHEN, repatched: true });
  });

  it("does not PATCH at all when the clone already speaks the expected voice", async () => {
    const patched = stubVapi({ ...TUNED, voiceId: STEPHEN });
    const res = await ensureCloneVoice("k", "clone_1", STEPHEN);
    expect(patched.body).toBeNull();
    expect(res).toEqual({ aligned: true, actual: STEPHEN, repatched: false });
  });

  it("never blocks a spawn when the clone has no readable voice", async () => {
    const patched = stubVapi(undefined);
    const res = await ensureCloneVoice("k", "clone_1", STEPHEN);
    expect(patched.body).toBeNull();
    expect(res).toEqual({ aligned: true, actual: null, repatched: false });
  });

  it("still ships a provider when the clone's voice carries none", async () => {
    const patched = stubVapi({ voiceId: HOPE, model: "eleven_turbo_v2_5" });
    await ensureCloneVoice("k", "clone_1", STEPHEN);
    expect(sentVoice(patched).provider).toBe("11labs");
    expect(sentVoice(patched).model).toBe("eleven_turbo_v2_5");
  });
});

// ── Clone-hardening pass (2026-07-29): base pin + post-create verification.
// The shared base drifted 3x in two weeks with zero signal (Cal → Mark-Casual
// → Hope). diffBaseAgainstPin catches upstream drift the payload would
// faithfully propagate; diffCloneAgainstPayload catches Vapi dropping or
// normalizing what we sent. Both are warnings-only by contract — the wiring
// test at the bottom pins that a drifted base still spawns ok:true.
describe("clone config verification (base pin + payload echo)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Base Val's API truth as verified 2026-07-29 (~13:03Z) — the clean fixture.
  // Deliberately includes UNPINNED fields (voiceId=Hope, confidenceThreshold)
  // to prove the pin ignores them.
  const CLEAN_BASE = () => ({
    name: "Val - Voice Agent",
    voice: { provider: "11labs", model: "eleven_turbo_v2_5", speed: 1.1, optimizeStreamingLatency: 3, voiceId: "OYTbf65OHHFELVut7v2H" },
    transcriber: { provider: "deepgram", model: "flux-general-en", language: "en", confidenceThreshold: 0.4, keyterm: ["SMS", "free spins", "Lucky Seven"] },
    model: { provider: "openai", model: "gpt-5.2", maxTokens: 150, messages: [{ role: "system", content: "You are Harper." }] },
    startSpeakingPlan: { waitSeconds: 0.5 },
    stopSpeakingPlan: { numWords: 3, backoffSeconds: 1, acknowledgementPhrases: ["okay"], interruptionPhrases: ["stop"] },
    backgroundDenoisingEnabled: true,
  });

  describe("diffBaseAgainstPin", () => {
    it("passes today's verified base config clean — including the unpinned voiceId", () => {
      expect(diffBaseAgainstPin(CLEAN_BASE())).toEqual([]);
    });

    it("flags a transcriber provider switch (the Soniox trap)", () => {
      const base = CLEAN_BASE();
      base.transcriber = { provider: "soniox", model: "stt-rt-v5" } as never;
      const drift = diffBaseAgainstPin(base);
      expect(drift.some((d) => d.includes("transcriber.provider"))).toBe(true);
      expect(drift.some((d) => d.includes("keyterm is empty"))).toBe(true);
    });

    it("flags smart endpointing reappearing (Flux owns end-of-turn)", () => {
      const base = CLEAN_BASE();
      base.startSpeakingPlan = { waitSeconds: 0.5, smartEndpointingPlan: { provider: "vapi" } } as never;
      expect(diffBaseAgainstPin(base).some((d) => d.includes("smartEndpointingPlan"))).toBe(true);
    });

    it("flags model.temperature appearing — the stale-panel-save fingerprint", () => {
      const base = CLEAN_BASE();
      (base.model as Record<string, unknown>).temperature = 0.5;
      expect(diffBaseAgainstPin(base).some((d) => d.includes("temperature"))).toBe(true);
    });

    it("flags a voice-tuning change (speed) until the pin is updated", () => {
      const base = CLEAN_BASE();
      base.voice.speed = 1.0;
      expect(diffBaseAgainstPin(base).some((d) => d.includes("voice.speed"))).toBe(true);
    });

    it("flags wiped keyterms — STT biasing lost", () => {
      const base = CLEAN_BASE();
      base.transcriber.keyterm = [];
      expect(diffBaseAgainstPin(base).some((d) => d.includes("keyterm is empty"))).toBe(true);
    });
  });

  describe("diffCloneAgainstPayload", () => {
    const PAYLOAD = () => ({
      name: "L7 AU (2026-07-29)",
      voice: { provider: "11labs", model: "eleven_turbo_v2_5", speed: 1.1, voiceId: "3jR9BuQAOPMWUjWpi0ll" },
      transcriber: { provider: "deepgram", model: "flux-general-en", keyterm: ["SMS", "Lucky Seven", "free spins"] },
      model: { provider: "openai", model: "gpt-5.2", maxTokens: 150, tools: [], messages: [{ role: "system", content: "SCRIPT PROMPT" }] },
      startSpeakingPlan: { waitSeconds: 0.5 },
      firstMessageMode: "assistant-speaks-first",
      server: { url: "https://voizo-eight.vercel.app/api/webhooks/vapi/script-call", timeoutSeconds: 20 },
    });
    const echo = () => JSON.parse(JSON.stringify({ ...PAYLOAD(), id: "clone_1" }));

    it("passes a faithful echo clean", () => {
      expect(diffCloneAgainstPayload(echo(), PAYLOAD())).toEqual([]);
    });

    it("flags a swapped voiceId", () => {
      const created = echo();
      created.voice.voiceId = "OYTbf65OHHFELVut7v2H";
      expect(diffCloneAgainstPayload(created, PAYLOAD()).some((d) => d.includes("voice.voiceId"))).toBe(true);
    });

    it("flags dropped keyterms (superset is fine, loss is not)", () => {
      const created = echo();
      created.transcriber.keyterm = ["SMS", "extra-is-ok"];
      const out = diffCloneAgainstPayload(created, PAYLOAD());
      expect(out.some((d) => d.includes("keyterm") && d.includes("missing"))).toBe(true);
    });

    it("flags a webhook URL that did not land — the silent killer", () => {
      const created = echo();
      created.server.url = "https://something-else.example.com/hook";
      expect(diffCloneAgainstPayload(created, PAYLOAD()).some((d) => d.includes("server.url"))).toBe(true);
    });

    it("flags smart endpointing appearing on the created clone unrequested", () => {
      const created = echo();
      created.startSpeakingPlan.smartEndpointingPlan = { provider: "vapi" };
      expect(diffCloneAgainstPayload(created, PAYLOAD()).some((d) => d.includes("smartEndpointingPlan"))).toBe(true);
    });

    it("flags a mutated system prompt", () => {
      const created = echo();
      created.model.messages = [{ role: "system", content: "NOT THE SCRIPT" }];
      expect(diffCloneAgainstPayload(created, PAYLOAD()).some((d) => d.includes("system prompt differs"))).toBe(true);
    });

    it("flags tools reappearing on a noTools clone", () => {
      const created = echo();
      created.model.tools = [{ type: "endCall" }];
      expect(diffCloneAgainstPayload(created, PAYLOAD()).some((d) => d.includes("model.tools"))).toBe(true);
    });
  });

  describe("createClone wiring", () => {
    type FakeRes = { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> };
    // GET → base; POST → echo of the posted payload (+id), optionally mutated —
    // a faithful Vapi against which only real drift produces warnings.
    function stubVapiEcho(base: Record<string, unknown>, mutate?: (body: Record<string, unknown>) => void) {
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit): Promise<FakeRes> => {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>;
          if (mutate) mutate(body);
          return { ok: true, status: 200, json: async () => ({ ...body, id: "clone_1" }), text: async () => "" };
        }
        return { ok: true, status: 200, json: async () => base, text: async () => "" };
      }));
    }

    it("reports clean verification when the base matches the pin and Vapi echoes faithfully", async () => {
      vi.stubEnv("VAPI_SCRIPT_BASE_ASSISTANT_ID", "base_val");
      stubVapiEcho(CLEAN_BASE());
      const res = await createClone("k", "base_val", {});
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verification?.baseDrift).toEqual([]);
        expect(res.verification?.cloneMismatches).toEqual([]);
      }
    });

    it("NEVER blocks: a drifted base still clones ok:true, with the drift reported", async () => {
      vi.stubEnv("VAPI_SCRIPT_BASE_ASSISTANT_ID", "base_val");
      const base = CLEAN_BASE();
      (base.model as Record<string, unknown>).temperature = 0.5; // panel-save fingerprint
      stubVapiEcho(base);
      const res = await createClone("k", "base_val", {});
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verification?.baseDrift.some((d) => d.includes("temperature"))).toBe(true);
      }
    });

    it("reports a Vapi-side mutation of the created clone", async () => {
      vi.stubEnv("VAPI_SCRIPT_BASE_ASSISTANT_ID", "base_val");
      stubVapiEcho(CLEAN_BASE(), (body) => {
        (body.voice as Record<string, unknown>).voiceId = "something-else";
      });
      const res = await createClone("k", "base_val", {});
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verification?.cloneMismatches.some((d) => d.includes("voice.voiceId"))).toBe(true);
      }
    });

    it("skips the base pin for a non-designated base (no pin exists for Ernie)", async () => {
      vi.stubEnv("VAPI_SCRIPT_BASE_ASSISTANT_ID", "base_val");
      const base = CLEAN_BASE();
      base.voice.speed = 1.0; // would drift if pinned
      stubVapiEcho(base);
      const res = await createClone("k", "base_ernie", {});
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.verification?.baseDrift).toEqual([]);
      }
    });
  });
});
