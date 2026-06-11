// Guards on VOIZO_SYSTEM_PREFIX — the dev-controlled instructions prepended to
// every clone's prompt. Rule #1 (SMS handling, v2 2026-06-11): the verbal
// dispatch confirmation ("I'll send you an SMS now") is the announce signal the
// webhook's mode-aware dispatch keys on (agentMentionedSms / consent window),
// an explicit customer objection must always veto, and the rule must claim
// precedence over conflicting base-script lines (Val/STEVIC bases carry
// announce-after-refusal wording). The earlier ask-first variant was reverted
// per the client's registration-opt-in direction (Val, 2026-06-11).
import { describe, expect, it } from "vitest";
import { VOIZO_SYSTEM_PREFIX } from "./cloneAssistant";
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
