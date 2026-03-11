import { supabase } from "./supabase";

export type Status = "Completed" | "Stopped" | "Active" | "Paused";
export type Group = string;

export interface Campaign {
  id: number;
  name: string;
  totalContacts: number;
  totalCalls: number;
  connectRate: string;
  connectCount: number;
  successRate: string;
  successCount: number;
  status: Status;
  group: Group;
  isDuplicate?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToCampaign(row: any): Campaign {
  return {
    id: row.id,
    name: row.name,
    totalContacts: row.total_contacts,
    totalCalls: row.total_calls,
    connectRate: row.connect_rate,
    connectCount: row.connect_count,
    successRate: row.success_rate,
    successCount: row.success_count,
    status: row.status,
    group: row.group_name,
    isDuplicate: row.is_duplicate ?? false,
  };
}

export async function fetchCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("*")
    .order("id", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToCampaign);
}

export async function insertCampaign(c: Omit<Campaign, "id">): Promise<Campaign> {
  const { data, error } = await supabase
    .from("campaigns")
    .insert({
      name: c.name,
      total_contacts: c.totalContacts,
      total_calls: c.totalCalls,
      connect_rate: c.connectRate,
      connect_count: c.connectCount,
      success_rate: c.successRate,
      success_count: c.successCount,
      status: c.status,
      group_name: c.group,
      is_duplicate: c.isDuplicate ?? false,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToCampaign(data);
}

export async function deleteCampaign(id: number): Promise<void> {
  const { error } = await supabase.from("campaigns").delete().eq("id", id);
  if (error) throw error;
}

export async function archiveCampaign(id: number): Promise<void> {
  const { error } = await supabase.from("campaigns").update({ group_name: "Archived" }).eq("id", id);
  if (error) throw error;
}

export async function recoverCampaign(id: number): Promise<void> {
  const { error } = await supabase.from("campaigns").update({ group_name: "RND" }).eq("id", id);
  if (error) throw error;
}

export async function updateCampaignName(id: number, name: string): Promise<void> {
  const { error } = await supabase.from("campaigns").update({ name }).eq("id", id);
  if (error) throw error;
}

// Kept as empty fallback so existing imports don't break
export const initialCampaigns: Campaign[] = [];
