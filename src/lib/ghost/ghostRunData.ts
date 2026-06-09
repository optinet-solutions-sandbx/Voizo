import type { SupabaseClient } from "@supabase/supabase-js";

// Service-role CRUD for the ghost_runs ingress/audit table. Functions take the
// Supabase client as a parameter (DI) — same shape as dncSuppressedSet /
// leaseSlotForGhost — so they unit-test without mocking the env-throwing
// supabaseServer singleton. Routes pass `supabaseAdmin`. RLS denies anon; only
// the service role reaches these rows. NB: ghost_runs stores AUDIT only (counts,
// status, the materialized campaign_id) — never the uploaded phone list.

export type GhostTier = "test" | "live";
export type GhostStatus =
  | "draft"
  | "scrubbing"
  | "ready"
  | "launching"
  | "launched"
  | "failed";

export interface GhostRunRow {
  id: string;
  slug: string;
  name: string;
  operator: string;
  tier: GhostTier;
  base_assistant_id: string;
  status: GhostStatus;
  uploaded_count: number;
  scrubbed_count: number;
  suppressed_count: number;
  fail_reason: string | null;
  campaign_id: string | null;
  created_at: string;
  updated_at: string;
  launched_at: string | null;
}

export interface CreateGhostRunInput {
  name: string;
  operator: string;
  tier: GhostTier;
  baseAssistantId: string;
  uploadedCount?: number;
}

export type GhostRunPatch = Partial<{
  status: GhostStatus;
  scrubbed_count: number;
  suppressed_count: number;
  fail_reason: string | null;
  campaign_id: string | null;
  launched_at: string | null;
}>;

export async function createGhostRun(
  supabase: SupabaseClient,
  input: CreateGhostRunInput,
): Promise<GhostRunRow> {
  const slug = crypto.randomUUID().slice(0, 8);
  const { data, error } = await supabase
    .from("ghost_runs")
    .insert({
      slug,
      name: input.name,
      operator: input.operator,
      tier: input.tier,
      base_assistant_id: input.baseAssistantId,
      status: "draft",
      uploaded_count: input.uploadedCount ?? 0,
    })
    .select()
    .single();
  if (error) throw error;
  return data as GhostRunRow;
}

export async function listGhostRuns(supabase: SupabaseClient): Promise<GhostRunRow[]> {
  const { data, error } = await supabase
    .from("ghost_runs")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data as GhostRunRow[]) ?? [];
}

export async function getGhostRun(
  supabase: SupabaseClient,
  id: string,
): Promise<GhostRunRow | null> {
  const { data, error } = await supabase.from("ghost_runs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as GhostRunRow) ?? null;
}

export async function getGhostRunBySlug(
  supabase: SupabaseClient,
  slug: string,
): Promise<GhostRunRow | null> {
  const { data, error } = await supabase.from("ghost_runs").select("*").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return (data as GhostRunRow) ?? null;
}

export async function updateGhostRun(
  supabase: SupabaseClient,
  id: string,
  patch: GhostRunPatch,
): Promise<GhostRunRow> {
  const { data, error } = await supabase
    .from("ghost_runs")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data as GhostRunRow;
}
