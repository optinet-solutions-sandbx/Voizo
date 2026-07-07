/**
 * Vapi Live Call Control — voicemail auto-hangup kill path (2026-07-07).
 *
 * Spec: docs/2026-07-07_DOC_Voicemail_Autohangup_LiveClassifier_Spec.md.
 * Consumed by the end-of-call webhook's `transcript` branch: when a final
 * customer utterance is conclusively a voicemail greeting, the route POSTs
 * {type:"end-call"} to the call's monitor.controlUrl and Vapi ends the call —
 * turning the ~27s LLM-detected hangup into a ~5-10s programmatic one.
 *
 * Payload + controlUrl resolution mirror the Listener Lab's browser-proven
 * lib/lab-control.ts (vapi-voiceagent-test @ e084c55). controlUrl presence on
 * real SIP calls verified in production 2026-07-07 (call 019f39e4…).
 */
// Relative import (not "@/"): the vitest suite has no path-alias config; every
// test-covered lib module imports relatively (see transcriptClassify.test.ts).
import { isConclusiveVoicemail } from "../transcriptClassify";

/**
 * If this webhook message is a FINAL, USER-side transcript utterance that is
 * conclusively a voicemail greeting, return the utterance; else null.
 * Pure decision logic — the route owns the flag gate and the kill POST.
 * Role filter matters: the agent itself says "leave a message" phrases (prompt
 * rule #4 quotes them), so assistant-side transcripts must never trigger.
 */
export function getKillableVoicemailUtterance(message: Record<string, unknown>): string | null {
  if (!message || message.type !== "transcript") return null;
  if (message.role !== "user" || message.transcriptType !== "final") return null;
  const text = typeof message.transcript === "string" ? message.transcript.trim() : "";
  if (!text) return null;
  return isConclusiveVoicemail(text) ? text : null;
}

/**
 * Resolve the call's Live Call Control URL: prefer the hint delivered on the
 * webhook event (message.call.monitor.controlUrl); fall back to one
 * GET /call/{id} — kill-positive events are ~1 per voicemail call, so the
 * fallback costs at most one GET per hangup.
 */
export async function resolveControlUrl(
  vapiPrivateKey: string,
  callId: string | undefined,
  hint: string | undefined,
): Promise<string | null> {
  if (hint) return hint;
  if (!callId || !vapiPrivateKey) return null;
  const res = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${vapiPrivateKey}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5000), // route convention (see end-of-call re-fetch); a stall must not pin the invocation
  });
  if (!res.ok) return null;
  const call = (await res.json()) as { monitor?: { controlUrl?: string } };
  return call.monitor?.controlUrl ?? null;
}

/**
 * End the live call. The controlUrl is itself the capability (no auth header —
 * same contract the lab uses). Safe on re-delivered events: a POST to an
 * already-ended call's controlUrl fails with a 4xx, which we just report.
 * Host-guarded: the URL arrives in a webhook body, so refuse anything that
 * isn't a Vapi host — the only SSRF-shaped input this codebase fetches.
 */
export async function endCallViaControlUrl(
  controlUrl: string,
): Promise<{ ok: boolean; status: number }> {
  let host: string;
  try {
    host = new URL(controlUrl).hostname;
  } catch {
    return { ok: false, status: 0 };
  }
  if (!(host === "vapi.ai" || host.endsWith(".vapi.ai"))) return { ok: false, status: 0 };
  const res = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "end-call" }),
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status };
}

// The two assistant fields the kill path depends on: live transcript streaming
// to our webhook, and a controlUrl on each call. Everything else is inherited.
const REQUIRED_SERVER_MESSAGES = ["transcript", "end-of-call-report"] as const;

export interface AutohangupAssistantShape {
  serverMessages?: string[];
  monitorPlan?: Record<string, unknown>;
}

/**
 * GET-merge-PATCH decision: given a clone's current config, return the minimal
 * PATCH body that makes voicemail auto-hangup work, or null if nothing is
 * needed. Union semantics — never removes message types or monitorPlan keys the
 * base configured (Val-lineage clones stream 5 types today; we leave them be).
 * Sending ONLY these two top-level fields is safe on Vapi PATCH: other fields
 * (model, voice, …) are untouched because they're absent from the body.
 */
export function buildAutohangupAssistantPatch(
  assistant: AutohangupAssistantShape,
): { serverMessages?: string[]; monitorPlan?: Record<string, unknown> } | null {
  const patch: { serverMessages?: string[]; monitorPlan?: Record<string, unknown> } = {};

  const existing = assistant.serverMessages ?? [];
  const missing = REQUIRED_SERVER_MESSAGES.filter((m) => !existing.includes(m));
  if (missing.length > 0) patch.serverMessages = [...existing, ...missing];

  const plan = assistant.monitorPlan ?? {};
  if (plan.listenEnabled !== true || plan.controlEnabled !== true) {
    patch.monitorPlan = { ...plan, listenEnabled: true, controlEnabled: true };
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Ensure a campaign clone streams transcripts + exposes controlUrl. Best-effort
 * by contract: returns a report, NEVER throws — a failed PATCH must not fail
 * campaign creation/rebind (Val-lineage clones already stream via inheritance;
 * a non-patched other-lineage clone just never triggers kills — fail-safe).
 * Called post-clone (createClone is untouchable by project rule).
 */
export async function ensureVoicemailAutohangupConfig(
  vapiPrivateKey: string,
  assistantId: string,
): Promise<{ ok: boolean; patched: boolean; detail?: string }> {
  try {
    const getRes = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, {
      headers: { Authorization: `Bearer ${vapiPrivateKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!getRes.ok) return { ok: false, patched: false, detail: `GET ${getRes.status}` };
    const assistant = (await getRes.json()) as AutohangupAssistantShape;

    // ⚠ Union caveat (review #5): when GET returns NO serverMessages field, the
    // assistant runs on Vapi's implicit default set and this PATCH replaces it
    // with the explicit minimal list. Fine for Voizo clones (our webhook ignores
    // the other types), but verify against a bare assistant before enabling the
    // flag on non-Val lineages whose bases rely on default-set messages.
    const patch = buildAutohangupAssistantPatch(assistant);
    if (!patch) return { ok: true, patched: false };

    const patchRes = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${vapiPrivateKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(5000),
    });
    if (!patchRes.ok) {
      const body = await patchRes.text().catch(() => "");
      return { ok: false, patched: false, detail: `PATCH ${patchRes.status} ${body.slice(0, 150)}` };
    }
    return { ok: true, patched: true };
  } catch (err) {
    return { ok: false, patched: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
