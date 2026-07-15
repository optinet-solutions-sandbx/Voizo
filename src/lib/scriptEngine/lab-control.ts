// Server-only: VAPI Live Call Control — inject messages into an active call.

const VAPI_BASE = "https://api.vapi.ai";

// Best-effort per-instance cache; webhook payloads usually carry the controlUrl
// so this is only a fallback optimization.
const controlUrlCache = new Map<string, string>();

export async function getControlUrl(
  callId: string,
  hint?: string | null
): Promise<string | null> {
  if (hint) {
    controlUrlCache.set(callId, hint);
    return hint;
  }
  const cached = controlUrlCache.get(callId);
  if (cached) return cached;

  const apiKey = process.env.VAPI_PRIVATE_KEY;
  if (!apiKey) return null;
  const res = await fetch(`${VAPI_BASE}/call/${callId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const call = await res.json();
  const url: string | undefined = call?.monitor?.controlUrl;
  if (url) {
    controlUrlCache.set(callId, url);
    return url;
  }
  return null;
}

export type InjectResult = { ok: boolean; status: number; body?: string };

async function postControl(controlUrl: string, payload: unknown): Promise<InjectResult> {
  const res = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.text().catch(() => "");
  return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
}

/** Whisper a [STAFF] briefing note into the conversation context. */
export async function injectStaffNote(
  controlUrl: string,
  text: string,
  triggerResponse: boolean
): Promise<InjectResult> {
  return postControl(controlUrl, {
    type: "add-message",
    message: { role: "system", content: `[STAFF] ${text}` },
    triggerResponseEnabled: triggerResponse,
  });
}

/** Force the agent to speak now (used only for end-of-call goodbyes). */
export async function injectSay(
  controlUrl: string,
  content: string,
  endCallAfterSpoken = false
): Promise<InjectResult> {
  return postControl(controlUrl, {
    type: "say",
    content,
    ...(endCallAfterSpoken && { endCallAfterSpoken: true }),
  });
}

export async function endCall(controlUrl: string): Promise<InjectResult> {
  return postControl(controlUrl, { type: "end-call" });
}
