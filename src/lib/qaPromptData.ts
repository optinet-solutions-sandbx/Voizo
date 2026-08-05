// src/lib/qaPromptData.ts
//
// Data layer for the QA Prompt Testing tool (Reviews area):
//   1. the prompt library (listener_qa_prompts) — reusable QA prompts operators
//      test against real call transcripts, and
//   2. getQaCallDetail() — one call joined to its customer (campaign_numbers_v2)
//      and campaign (campaigns_v2) context, plus the normalized transcript + a
//      playable audio URL.
//
// SECURITY: everything goes through supabaseAdmin (service role), which bypasses
// RLS. listener_qa_prompts is default-deny to the anon key (see
// supabase-migration-qa-prompts.sql). Keep all access behind /api/qa-prompt-testing/*.
import { supabaseAdmin } from "./supabaseServer";
import { audioUrlFor, transcriptText } from "./labelData";

export interface QaPrompt {
  id: string;
  title: string;
  content: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToPrompt(r: Record<string, unknown>): QaPrompt {
  return {
    id: r.id as string,
    title: (r.title as string) ?? "",
    content: (r.content as string) ?? "",
    isActive: Boolean(r.is_active),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

const PROMPT_COLS = "id, title, content, is_active, created_at, updated_at";

/** All prompts, active first, then most-recently-updated. */
export async function listQaPrompts(): Promise<QaPrompt[]> {
  const { data, error } = await supabaseAdmin
    .from("listener_qa_prompts")
    .select(PROMPT_COLS)
    .order("is_active", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => rowToPrompt(r as Record<string, unknown>));
}

export async function createQaPrompt(input: {
  title: string;
  content: string;
  isActive?: boolean;
}): Promise<QaPrompt> {
  // Only one default at a time — clear the flag on the others first.
  if (input.isActive) {
    await supabaseAdmin.from("listener_qa_prompts").update({ is_active: false }).eq("is_active", true);
  }
  const { data, error } = await supabaseAdmin
    .from("listener_qa_prompts")
    .insert({ title: input.title, content: input.content, is_active: Boolean(input.isActive) })
    .select(PROMPT_COLS)
    .single();
  if (error || !data) throw error ?? new Error("Insert failed");
  return rowToPrompt(data as Record<string, unknown>);
}

export async function updateQaPrompt(
  id: string,
  patch: { title?: string; content?: string; isActive?: boolean },
): Promise<QaPrompt> {
  // Promoting this one to default demotes every other.
  if (patch.isActive) {
    await supabaseAdmin.from("listener_qa_prompts").update({ is_active: false }).neq("id", id);
  }
  const upd: Record<string, unknown> = {};
  if (patch.title !== undefined) upd.title = patch.title;
  if (patch.content !== undefined) upd.content = patch.content;
  if (patch.isActive !== undefined) upd.is_active = patch.isActive;
  const { data, error } = await supabaseAdmin
    .from("listener_qa_prompts")
    .update(upd)
    .eq("id", id)
    .select(PROMPT_COLS)
    .single();
  if (error || !data) throw error ?? new Error("Update failed");
  return rowToPrompt(data as Record<string, unknown>);
}

export async function deleteQaPrompt(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("listener_qa_prompts").delete().eq("id", id);
  if (error) throw error;
}

// ── Single call detail (customer + campaign + transcript + audio) ──────────────

export interface QaCallDetail {
  callId: string;
  createdAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  status: string;
  endedReason: string | null;
  hangupCause: string | null;
  goalReached: boolean | null;
  voicemail: boolean | null;
  vapiCallId: string | null;
  transcript: string;
  audioUrl: string | null;
  customer: {
    id: string | null;
    phone: string | null;
    displayName: string | null;
    outcome: string | null;
    attemptCount: number | null;
    lastAttemptedAt: string | null;
    createdAt: string | null;
  };
  campaign: {
    id: string | null;
    name: string | null;
    campaignType: string | null;
    agentMode: string | null;
    scriptName: string | null;
    voiceName: string | null;
    assistantName: string | null;
    timezone: string | null;
    status: string | null;
    source: string | null;
    realtime: boolean | null;
    smsEnabled: boolean | null;
    createdAt: string | null;
  };
}

// PostgREST FK embeds come back as an object OR a single-element array depending
// on the relationship metadata — normalize to the first (mirrors labelData).
function one(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) return (v[0] as Record<string, unknown>) ?? null;
  return (v as Record<string, unknown>) ?? null;
}

/** One call joined to its customer + campaign context. null when the id is unknown. */
export async function getQaCallDetail(callId: string): Promise<QaCallDetail | null> {
  const { data, error } = await supabaseAdmin
    .from("calls_v2")
    .select(
      "id, created_at, answered_at, ended_at, duration_seconds, status, ended_reason, hangup_cause, goal_reached, voicemail, vapi_call_id, transcript, recording_url, campaign_id, campaign_number_id, " +
        "campaign_numbers_v2!campaign_number_id(id, phone_e164, display_name, outcome, attempt_count, last_attempted_at, created_at), " +
        "campaigns_v2!campaign_id(id, name, campaign_type, agent_mode, script_name, voice_name, vapi_assistant_name, timezone, status, source, realtime, sms_enabled, created_at)",
    )
    .eq("id", callId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const c = data as unknown as Record<string, unknown>;
  const cust = one(c.campaign_numbers_v2);
  const camp = one(c.campaigns_v2);
  return {
    callId: c.id as string,
    createdAt: (c.created_at as string) ?? null,
    answeredAt: (c.answered_at as string) ?? null,
    endedAt: (c.ended_at as string) ?? null,
    durationSeconds: (c.duration_seconds as number | null) ?? null,
    status: (c.status as string) ?? "",
    endedReason: (c.ended_reason as string | null) ?? null,
    hangupCause: (c.hangup_cause as string | null) ?? null,
    goalReached: (c.goal_reached as boolean | null) ?? null,
    voicemail: (c.voicemail as boolean | null) ?? null,
    vapiCallId: (c.vapi_call_id as string | null) ?? null,
    transcript: transcriptText(c.transcript),
    audioUrl: audioUrlFor(c.recording_url),
    customer: {
      id: (cust?.id as string) ?? null,
      phone: (cust?.phone_e164 as string) ?? null,
      displayName: (cust?.display_name as string) ?? null,
      outcome: (cust?.outcome as string) ?? null,
      attemptCount: (cust?.attempt_count as number | null) ?? null,
      lastAttemptedAt: (cust?.last_attempted_at as string) ?? null,
      createdAt: (cust?.created_at as string) ?? null,
    },
    campaign: {
      id: (camp?.id as string) ?? null,
      name: (camp?.name as string) ?? null,
      campaignType: (camp?.campaign_type as string) ?? null,
      agentMode: (camp?.agent_mode as string) ?? null,
      scriptName: (camp?.script_name as string) ?? null,
      voiceName: (camp?.voice_name as string) ?? null,
      assistantName: (camp?.vapi_assistant_name as string) ?? null,
      timezone: (camp?.timezone as string) ?? null,
      status: (camp?.status as string) ?? null,
      source: (camp?.source as string) ?? null,
      realtime: (camp?.realtime as boolean | null) ?? null,
      smsEnabled: (camp?.sms_enabled as boolean | null) ?? null,
      createdAt: (camp?.created_at as string) ?? null,
    },
  };
}
