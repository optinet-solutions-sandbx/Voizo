// src/lib/qaCallTimeline.ts
//
// Per-turn timing for a call, fetched ON DEMAND from Vapi (we don't persist it).
// Vapi's GET /call/{id} returns artifact.messages[] with role + secondsFromStart +
// duration; we map that to a spoken timeline (agent/customer only) and compute, for
// each agent turn that answers the customer, how long the agent took to respond.
// Used only by the QA Prompt Testing detail view — low volume, manual, read-only.
import { supabaseAdmin } from "./supabaseServer";

const VAPI_BASE = "https://api.vapi.ai";

export interface TimelineTurn {
  role: "agent" | "customer";
  atSec: number; // secondsFromStart
  text: string;
  gapSec: number | null; // silence since the previous spoken turn ended (null for the first)
  isResponse: boolean; // true when an agent turn directly answers a customer turn
}
export interface CallTimeline {
  available: boolean;
  reason?: string; // why it's unavailable (no-vapi-id, vapi-404 = not retained, …)
  durationSec: number | null;
  turns: TimelineTurn[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function getCallTimeline(callId: string): Promise<CallTimeline> {
  const key = process.env.VAPI_PRIVATE_KEY?.trim();
  if (!key) return { available: false, reason: "vapi-not-configured", durationSec: null, turns: [] };

  const { data, error } = await supabaseAdmin.from("calls_v2").select("vapi_call_id").eq("id", callId).maybeSingle();
  if (error) throw error;
  const vapiId = (data?.vapi_call_id as string | null) ?? null;
  if (!vapiId) return { available: false, reason: "no-vapi-id", durationSec: null, turns: [] };

  let res: Response;
  try {
    res = await fetch(`${VAPI_BASE}/call/${vapiId}`, { headers: { Authorization: `Bearer ${key}` } });
  } catch {
    return { available: false, reason: "vapi-unreachable", durationSec: null, turns: [] };
  }
  if (!res.ok) return { available: false, reason: `vapi-${res.status}`, durationSec: null, turns: [] };

  const call = (await res.json()) as { artifact?: { messages?: unknown[] }; messages?: unknown[] };
  const msgs = (call.artifact?.messages ?? call.messages ?? []) as Array<Record<string, unknown>>;

  const turns: TimelineTurn[] = [];
  let prevEnd: number | null = null;
  let prevRole: "agent" | "customer" | null = null;
  let maxEnd = 0;

  for (const m of msgs) {
    const role = m.role === "bot" ? "agent" : m.role === "user" ? "customer" : null;
    if (!role) continue; // skip system / tool messages (not spoken)
    const text = String(m.message ?? m.content ?? "").trim();
    if (!text) continue;
    const atSec = typeof m.secondsFromStart === "number" ? m.secondsFromStart : 0;
    const durSec = typeof m.duration === "number" ? m.duration / 1000 : 0;
    const gapSec = prevEnd == null ? null : Math.max(0, round1(atSec - prevEnd));
    turns.push({ role, atSec: round1(atSec), text, gapSec, isResponse: role === "agent" && prevRole === "customer" });
    prevEnd = atSec + durSec;
    prevRole = role;
    if (prevEnd > maxEnd) maxEnd = prevEnd;
  }

  return {
    available: turns.length > 0,
    reason: turns.length ? undefined : "no-messages",
    durationSec: maxEnd ? Math.round(maxEnd) : null,
    turns,
  };
}
