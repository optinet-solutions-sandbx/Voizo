import { supabase } from "./supabase";
import type { RecurrencePattern } from "./types/recurrence";

export type CallWindow = {
  day: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
  start: string;
  end: string;
};

export interface CampaignV2CreateInput {
  name: string;
  systemPrompt: string;
  vapiAssistantId?: string; // Optional: recurring parents are created without a clone (no worker leased). Required for Fixed campaigns.
  vapiAssistantName?: string;
  vapiSipUri?: string;
  vapiPoolSlotId?: string; // SIP pool slot id when USE_SIP_POOL=true; null/undefined for legacy per-campaign flow
  baseAssistantId?: string; // Source agent the clone was made from; persisted for re-bind after eject
  voiceId?: string; // ElevenLabs voice ID chosen at create time; persisted for re-bind so operator intent survives eject. NULL = use base agent's default voice.
  segmentId?: number; // customer.io segment ID (single-segment imports only); persisted for Step 5 Duplicate, Step 6 Manual refresh, Step 7 Resume-diff. NULL for multi-segment imports.
  timezone: string;
  startAt?: string | null;
  endAt?: string | null;
  callWindows: CallWindow[];
  smsEnabled: boolean;
  smsTemplate?: string | null;
  smsOnGoalReachedOnly?: boolean;
  numbers: string[];
  createdBy?: string | null;
  campaignType?: "fixed" | "recurring"; // Defaults to "fixed". Recurring parents save as status='running' with no clone; children are spawned by the scheduler.
  recurrencePattern?: RecurrencePattern | null; // Populated for campaignType='recurring'; null otherwise.
}

export function defaultCallWindows(): CallWindow[] {
  return [
    { day: "sun", start: "12:00", end: "20:00" },
    { day: "mon", start: "12:00", end: "20:00" },
    { day: "tue", start: "12:00", end: "17:00" },
    { day: "wed", start: "12:00", end: "17:00" },
    { day: "thu", start: "12:00", end: "17:00" },
    { day: "fri", start: "18:00", end: "20:00" },
    { day: "sat", start: "12:00", end: "20:00" },
  ];
}

export function formatDefaultCallWindowsJson(): string {
  return JSON.stringify(defaultCallWindows(), null, 2);
}

export function parsePhoneList(input: string): string[] {
  const items = input
    .split(/[\n,]+/g)
    .map((value) => value.trim())
    .filter(Boolean);

  const normalized = items
    .map((value) => value.replace(/[^\d+]/g, ""))
    .map((value) => (value.startsWith("+") ? value : `+${value.replace(/[^\d]/g, "")}`))
    .filter((value) => /^\+\d{8,15}$/.test(value));

  return Array.from(new Set(normalized));
}

export async function createCampaignV2(input: CampaignV2CreateInput) {
  // Recurring parents save directly as 'running' (active schedule definition);
  // the scheduler scans them by type+status. Fixed campaigns keep the existing
  // draft→running flow gated by start_at + the queue-gate.
  const campaignType = input.campaignType ?? "fixed";
  const status = campaignType === "recurring" ? "running" : "draft";

  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns_v2")
    .insert({
      name: input.name,
      vapi_assistant_id: input.vapiAssistantId || null,
      vapi_assistant_name: input.vapiAssistantName || null,
      vapi_sip_uri: input.vapiSipUri || null,
      vapi_pool_slot_id: input.vapiPoolSlotId || null,
      base_assistant_id: input.baseAssistantId || null,
      voice_id: input.voiceId || null,
      segment_id: input.segmentId ?? null,
      system_prompt: input.systemPrompt,
      timezone: input.timezone,
      start_at: input.startAt || null,
      end_at: input.endAt || null,
      call_windows: input.callWindows,
      sms_enabled: input.smsEnabled,
      sms_template: input.smsTemplate || null,
      sms_on_goal_reached_only: input.smsOnGoalReachedOnly ?? true,
      status,
      campaign_type: campaignType,
      recurrence_pattern: input.recurrencePattern ?? null,
      created_by: input.createdBy || null,
    })
    .select()
    .single();

  if (campaignError) throw campaignError;

  // ── Back-link the leased pool slot to this campaign ──
  // The slot was already leased (assistant_id set) by clone-assistant before
  // this function ran. Now that the campaign row exists, set current_campaign_id
  // for operator observability and to satisfy the partial unique index.
  // Both vapiPoolSlotId AND vapiAssistantId are guaranteed for the Fixed flow
  // (the slot was leased to that specific assistant). Recurring parents enter
  // with neither — the && narrows the type and keeps the branch dead for them.
  if (input.vapiPoolSlotId && input.vapiAssistantId) {
    const { linkSlot } = await import("./vapi/sipPool");
    const linked = await linkSlot(supabase, {
      slotId: input.vapiPoolSlotId,
      campaignId: campaign.id,
      expectedAssistantId: input.vapiAssistantId,
    });
    if (!linked) {
      // Defensive: if the RPC refused (slot not leased to this assistant),
      // log and continue. Heartbeat reconciliation will surface the orphan.
      console.warn(
        `[createCampaignV2] linkSlot returned false for slot ${input.vapiPoolSlotId} ` +
        `(campaign ${campaign.id}, assistant ${input.vapiAssistantId})`,
      );
    }
  }

  const campaignRows = input.numbers.map((phone) => ({
    campaign_id: campaign.id,
    phone_e164: phone,
    outcome: "pending",
  }));

  if (campaignRows.length > 0) {
    const { error: numbersError } = await supabase.from("campaign_numbers_v2").insert(campaignRows);
    if (numbersError) throw numbersError;
  }

  return {
    campaign,
    numberCount: campaignRows.length,
  };
}

// --------------- Fetch helpers ---------------

export async function fetchCampaignsV2() {
  const { data, error } = await supabase
    .from("campaigns_v2")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchCampaignV2(id: string) {
  const { data, error } = await supabase
    .from("campaigns_v2")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function fetchCampaignNumbersV2(campaignId: string) {
  const { data, error } = await supabase
    .from("campaign_numbers_v2")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function fetchCallsV2(campaignId: string) {
  const { data, error } = await supabase
    .from("calls_v2")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchSmsMessagesV2(campaignId: string) {
  const { data, error } = await supabase
    .from("sms_messages_v2")
    .select("*")
    .eq("campaign_id", campaignId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function updateCampaignV2Status(id: string, status: string) {
  const { data, error } = await supabase
    .from("campaigns_v2")
    .update({ status })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function checkSuppression(phones: string[]): Promise<string[]> {
  if (phones.length === 0) return [];
  const { data, error } = await supabase
    .from("suppression_list")
    .select("phone_e164")
    .in("phone_e164", phones);
  if (error) throw error;
  return (data ?? []).map((r: { phone_e164: string }) => r.phone_e164);
}
