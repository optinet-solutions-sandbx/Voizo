/**
 * promptVersionExtract — PURE extraction helpers for prompt versioning (slice 2).
 *
 * No I/O, no env, no Supabase — just shape-tolerant readers over a Vapi assistant
 * object plus a sha256 hasher. Kept separate from promptVersionData.ts (which
 * imports the service-role client) so these can be unit-tested without env.
 *
 * The "effective system prompt" is exactly what createClone (cloneAssistant.ts)
 * POSTed to Vapi: VOIZO_SYSTEM_PREFIX + agent prompt, stored as the single
 * `system`-role message on the clone's model.messages. We read it back from the
 * immutable clone (Vapi GET) rather than reconstructing it — the clone is the
 * source of truth for "what actually ran".
 */

import crypto from "crypto";

/** Loose shape of the bits of a Vapi assistant we read. Everything optional — capture is best-effort. */
interface VapiAssistantShape {
  model?: {
    messages?: Array<{ role?: unknown; content?: unknown }>;
    provider?: unknown;
    model?: unknown;
    maxTokens?: unknown;
    temperature?: unknown;
  };
  voice?: {
    provider?: unknown;
    voiceId?: unknown;
    stability?: unknown;
    similarityBoost?: unknown;
  };
}

/**
 * Pull the effective system-prompt text from a Vapi assistant object.
 * Returns null when there is no usable system message (so the caller skips the
 * snapshot rather than storing an empty/garbage row).
 */
export function extractEffectiveSystemPrompt(assistant: unknown): string | null {
  const messages = (assistant as VapiAssistantShape)?.model?.messages;
  if (!Array.isArray(messages)) return null;
  const sys = messages.find((m) => m?.role === "system");
  const content = sys?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

/** Best-effort generation metadata. Omits fields the assistant doesn't carry. */
export function extractModelMeta(assistant: unknown): Record<string, unknown> {
  const m = (assistant as VapiAssistantShape)?.model;
  if (!m || typeof m !== "object") return {};
  const out: Record<string, unknown> = {};
  if (m.provider !== undefined) out.provider = m.provider;
  if (m.model !== undefined) out.model = m.model;
  if (m.maxTokens !== undefined) out.maxTokens = m.maxTokens;
  if (m.temperature !== undefined) out.temperature = m.temperature;
  return out;
}

/** Best-effort voice metadata. Omits fields the assistant doesn't carry. */
export function extractVoiceMeta(assistant: unknown): Record<string, unknown> {
  const v = (assistant as VapiAssistantShape)?.voice;
  if (!v || typeof v !== "object") return {};
  const out: Record<string, unknown> = {};
  if (v.provider !== undefined) out.provider = v.provider;
  if (v.voiceId !== undefined) out.voiceId = v.voiceId;
  if (v.stability !== undefined) out.stability = v.stability;
  if (v.similarityBoost !== undefined) out.similarityBoost = v.similarityBoost;
  return out;
}

/** Lowercase-hex sha256 of the prompt — dedupe key + drift detector. */
export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}
