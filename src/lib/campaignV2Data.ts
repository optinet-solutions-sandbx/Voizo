import { supabase } from "./supabase";

export type CallWindow = {
  day: "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
  start: string;
  end: string;
};

export interface CampaignV2CreateInput {
  name: string;
  systemPrompt: string;
  vapiAssistantId: string;
  vapiAssistantName?: string;
  timezone: string;
  startAt?: string | null;
  endAt?: string | null;
  callWindows: CallWindow[];
  smsEnabled: boolean;
  smsTemplate?: string | null;
  smsOnGoalReachedOnly?: boolean;
  numbers: string[];
  createdBy?: string | null;
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
  const { data: campaign, error: campaignError } = await supabase
    .from("campaigns_v2")
    .insert({
      name: input.name,
      vapi_assistant_id: input.vapiAssistantId,
      vapi_assistant_name: input.vapiAssistantName || null,
      system_prompt: input.systemPrompt,
      timezone: input.timezone,
      start_at: input.startAt || null,
      end_at: input.endAt || null,
      call_windows: input.callWindows,
      sms_enabled: input.smsEnabled,
      sms_template: input.smsTemplate || null,
      sms_on_goal_reached_only: input.smsOnGoalReachedOnly ?? true,
      status: "draft",
      created_by: input.createdBy || null,
    })
    .select()
    .single();

  if (campaignError) throw campaignError;

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
