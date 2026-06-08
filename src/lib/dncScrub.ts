import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The single source of truth for DNC/suppression scrubbing.
 * Returns the SET of phones (E.164) that are on suppression_list (V2) OR
 * do_not_call (V1, not archived). Mirrors the dialer's findNextNumber gate.
 * Used by: audience/segments (carve) + GhostPortal launch. NON-NEGOTIABLE gate.
 */
export async function dncSuppressedSet(
  supabase: SupabaseClient,
  phones: string[],
): Promise<Set<string>> {
  const set = new Set<string>();
  if (phones.length === 0) return set;
  const [supRes, dncRes] = await Promise.all([
    supabase.from("suppression_list").select("phone_e164").in("phone_e164", phones),
    supabase.from("do_not_call").select("phone_number").eq("archived", false).in("phone_number", phones),
  ]);
  for (const r of supRes.data ?? []) set.add(r.phone_e164 as string);
  for (const r of dncRes.data ?? []) set.add(r.phone_number as string);
  return set;
}
