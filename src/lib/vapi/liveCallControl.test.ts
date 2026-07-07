import { describe, it, expect } from "vitest";
import { getKillableVoicemailUtterance, buildAutohangupAssistantPatch } from "./liveCallControl";

// Vapi `transcript` serverMessage shapes — field names verified against the
// Listener Lab's working webhook (vapi-voiceagent-test app/api/lab/webhook/route.ts:262-263):
// role, transcriptType, transcript are siblings on `message`.
const vmText = "is not available. Please leave a message after the tone."; // verbatim, campaign 46a33f3e
const msg = (over: Record<string, unknown> = {}) => ({
  type: "transcript",
  role: "user",
  transcriptType: "final",
  transcript: vmText,
  ...over,
});

describe("getKillableVoicemailUtterance — fires only on final user voicemail lines", () => {
  it("returns the utterance for a final user transcript that is conclusively voicemail", () => {
    expect(getKillableVoicemailUtterance(msg())).toBe(vmText);
  });
  it("ignores partial transcripts (only final utterances are evidence)", () => {
    expect(getKillableVoicemailUtterance(msg({ transcriptType: "partial" }))).toBeNull();
  });
  it("ignores assistant-side transcripts (the agent SAYS 'leave a message' in rule #4)", () => {
    expect(getKillableVoicemailUtterance(msg({ role: "assistant" }))).toBeNull();
  });
  it("ignores live-human utterances (single weak phrase is never conclusive)", () => {
    expect(getKillableVoicemailUtterance(msg({ transcript: "Sorry, I'm not available on Tuesday." }))).toBeNull();
  });
  it("ignores non-transcript message types", () => {
    expect(getKillableVoicemailUtterance(msg({ type: "end-of-call-report" }))).toBeNull();
    expect(getKillableVoicemailUtterance(msg({ type: "status-update" }))).toBeNull();
  });
  it("tolerates missing/malformed fields without throwing", () => {
    expect(getKillableVoicemailUtterance({})).toBeNull();
    expect(getKillableVoicemailUtterance({ type: "transcript" })).toBeNull();
    expect(getKillableVoicemailUtterance(msg({ transcript: undefined }))).toBeNull();
    expect(getKillableVoicemailUtterance(msg({ transcript: 42 }))).toBeNull();
    expect(getKillableVoicemailUtterance(msg({ transcript: "   " }))).toBeNull();
  });
});

// Real Val-base shape (verified live 2026-07-07): serverMessages 5 types, monitorPlan both true.
const VAL_SHAPE = {
  serverMessages: ["tool-calls", "transcript", "status-update", "speech-update", "end-of-call-report"],
  monitorPlan: { listenEnabled: true, controlEnabled: true },
};

describe("buildAutohangupAssistantPatch — GET-merge-PATCH decision", () => {
  it("returns null when the clone already satisfies both requirements (Val lineage)", () => {
    expect(buildAutohangupAssistantPatch(VAL_SHAPE)).toBeNull();
  });
  it("sets both fields on a bare clone (Ernie lineage: nothing configured)", () => {
    expect(buildAutohangupAssistantPatch({})).toEqual({
      serverMessages: ["transcript", "end-of-call-report"],
      monitorPlan: { listenEnabled: true, controlEnabled: true },
    });
  });
  it("unions missing message types, preserving the existing list", () => {
    const patch = buildAutohangupAssistantPatch({
      serverMessages: ["tool-calls", "transcript"],
      monitorPlan: { listenEnabled: true, controlEnabled: true },
    });
    expect(patch).toEqual({ serverMessages: ["tool-calls", "transcript", "end-of-call-report"] });
  });
  it("patches only monitorPlan when messages are fine, preserving extra plan keys", () => {
    const patch = buildAutohangupAssistantPatch({
      serverMessages: ["transcript", "end-of-call-report"],
      monitorPlan: { listenEnabled: false, listenAuthenticationEnabled: true },
    });
    expect(patch).toEqual({
      monitorPlan: { listenEnabled: true, listenAuthenticationEnabled: true, controlEnabled: true },
    });
  });
});
