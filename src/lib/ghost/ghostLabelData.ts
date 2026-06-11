import type { SupabaseClient } from "@supabase/supabase-js";
import { hasRealConversation } from "../transcriptClassify";

// Service-role (DI) layer for GhostPortal's PER-RUN manual call review. Isolated
// from the main call_labels + the AI ("Claude") QA judge — these labels live in
// ghost_call_labels and are reviewed only on /s/<slug>. Functions take the
// Supabase client as a parameter (same shape as dncSuppressedSet/ghostScrub) so
// they unit-test without the env-throwing supabaseServer singleton. Relative
// imports (vitest does not resolve "@/").

export type GhostVerdict = "good" | "bad" | "unsure";

const VAPI_STORAGE_PREFIX = "https://storage.vapi.ai/";

// Same-origin proxy URL for a Vapi recording (CORS + SSRF-guarded in the proxy
// route). null when there's no usable recording. Mirrors labelData.audioUrlFor.
function audioUrlFor(recordingUrl: unknown): string | null {
  return typeof recordingUrl === "string" && recordingUrl.startsWith(VAPI_STORAGE_PREFIX)
    ? `/api/recordings/proxy?url=${encodeURIComponent(recordingUrl)}`
    : null;
}

// calls_v2.transcript is jsonb { text } (newer) or a raw string (older).
function transcriptText(t: unknown): string {
  if (typeof t === "string") return t;
  if (t && typeof t === "object" && "text" in t) return String((t as { text: unknown }).text ?? "");
  return "";
}

function phoneFrom(row: { campaign_numbers_v2?: { phone_e164: string } | { phone_e164: string }[] | null }): string | null {
  const p = row.campaign_numbers_v2;
  if (Array.isArray(p)) return p[0]?.phone_e164 ?? null;
  return p?.phone_e164 ?? null;
}

export interface GhostReviewCall {
  callId: string;
  phoneE164: string | null;
  status: string;
  durationSeconds: number | null;
  goalReached: boolean | null;
  createdAt: string;
  transcript: string;
  audioUrl: string | null;
  yourLabel: { verdict: GhostVerdict; reason: string | null } | null;
}

/**
 * Labelable calls for a ghost run's materialized campaign: real conversations
 * only (same inclusion rule as the main reviews queue — hasRealConversation),
 * joined with THIS operator's existing ghost label. Newest first.
 */
export async function listGhostRunCalls(
  supabase: SupabaseClient,
  campaignId: string,
  labeledBy: string,
): Promise<GhostReviewCall[]> {
  const { data, error } = await supabase
    .from("calls_v2")
    .select(
      "id, created_at, duration_seconds, status, goal_reached, transcript, recording_url, campaign_numbers_v2!campaign_number_id(phone_e164)",
    )
    .eq("campaign_id", campaignId)
    .not("transcript", "is", null)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const real = (data ?? []).filter((c) => hasRealConversation(transcriptText((c as { transcript: unknown }).transcript)));
  const ids = real.map((c) => (c as { id: string }).id);

  const labelByCall = new Map<string, { verdict: GhostVerdict; reason: string | null }>();
  if (ids.length > 0) {
    const { data: labels, error: lErr } = await supabase
      .from("ghost_call_labels")
      .select("call_id, verdict, reason")
      .eq("labeled_by", labeledBy)
      .in("call_id", ids);
    if (lErr) throw lErr;
    for (const l of labels ?? []) {
      labelByCall.set(l.call_id as string, {
        verdict: l.verdict as GhostVerdict,
        reason: (l.reason as string | null) ?? null,
      });
    }
  }

  return real.map((c) => {
    const row = c as Record<string, unknown>;
    return {
      callId: row.id as string,
      phoneE164: phoneFrom(row as { campaign_numbers_v2?: { phone_e164: string } | { phone_e164: string }[] | null }),
      status: row.status as string,
      durationSeconds: (row.duration_seconds as number | null) ?? null,
      goalReached: (row.goal_reached as boolean | null) ?? null,
      createdAt: row.created_at as string,
      transcript: transcriptText(row.transcript),
      audioUrl: audioUrlFor(row.recording_url),
      yourLabel: labelByCall.get(row.id as string) ?? null,
    };
  });
}

/** Guard: a label may only target a call that belongs to the run's campaign. */
export async function callBelongsToCampaign(
  supabase: SupabaseClient,
  callId: string,
  campaignId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("calls_v2")
    .select("id")
    .eq("id", callId)
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function upsertGhostLabel(
  supabase: SupabaseClient,
  input: { callId: string; labeledBy: string; verdict: GhostVerdict; reason: string | null },
) {
  const { data, error } = await supabase
    .from("ghost_call_labels")
    .upsert(
      {
        call_id: input.callId,
        labeled_by: input.labeledBy,
        verdict: input.verdict,
        reason: input.reason,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "call_id,labeled_by" },
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}
