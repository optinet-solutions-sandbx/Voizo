import { supabase } from "./supabase";

export interface KnowledgeBase {
  id: number;
  name: string;
  dataSources: number;
  dateOfCreation: string;
  archived: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToKB(row: any): KnowledgeBase {
  return {
    id: row.id,
    name: row.name,
    dataSources: row.data_sources,
    dateOfCreation: new Date(row.created_at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    archived: row.archived ?? false,
  };
}

export async function fetchKnowledgeBases(): Promise<KnowledgeBase[]> {
  const { data, error } = await supabase
    .from("knowledge_bases")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(rowToKB);
}

export async function insertKnowledgeBase(name: string): Promise<KnowledgeBase> {
  const { data, error } = await supabase
    .from("knowledge_bases")
    .insert({ name, data_sources: 0, archived: false })
    .select()
    .single();
  if (error) throw error;
  return rowToKB(data);
}

export async function archiveKnowledgeBase(id: number): Promise<void> {
  const { error } = await supabase.from("knowledge_bases").update({ archived: true }).eq("id", id);
  if (error) throw error;
}

export async function restoreKnowledgeBase(id: number): Promise<void> {
  const { error } = await supabase.from("knowledge_bases").update({ archived: false }).eq("id", id);
  if (error) throw error;
}

export async function deleteKnowledgeBase(id: number): Promise<void> {
  const { error } = await supabase.from("knowledge_bases").delete().eq("id", id);
  if (error) throw error;
}
