import { supabaseAdmin } from "./supabaseServer";
import { hasRealConversation } from "./transcriptClassify";

/**
 * Reviewer Labeling data layer (Agent training tab — slice 1).
 *
 * SECURITY: all access here goes through `supabaseAdmin` (service role), which
 * bypasses RLS. `call_labels` has RLS enabled with NO anon policy (default-deny),
 * so the public anon key cannot touch it. Keep reads/writes behind /api/reviews/*.
 */

export type Verdict = "good" | "bad" | "unsure";
export const VERDICTS: Verdict[] = ["good", "bad", "unsure"];

export interface CallLabel {
  verdict: Verdict;
  reason: string | null;
  labeledBy: string;
  updatedAt: string;
}

export interface ReviewQueueItem {
  callId: string;
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  createdAt: string;
  durationSeconds: number | null;
  status: string;
  goalReached: boolean | null;
  transcript: string;
  audioUrl: string | null; // proxied recording URL, or null if no recording
  yourLabel: CallLabel | null;
}

export interface ReviewCampaign {
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  conversationCount: number; // real conversations (post-filter)
  goalReachedCount: number; // among those, goal_reached === true
  labeledCount: number; // among those, labeled by this reviewer
}

const VAPI_STORAGE_PREFIX = "https://storage.vapi.ai/";

// Build the same-origin proxy URL for a Vapi recording (CORS workaround +
// SSRF-guarded in the proxy route). null when there's no usable recording.
function audioUrlFor(recordingUrl: unknown): string | null {
  if (typeof recordingUrl === "string" && recordingUrl.startsWith(VAPI_STORAGE_PREFIX)) {
    return `/api/recordings/proxy?url=${encodeURIComponent(recordingUrl)}`;
  }
  return null;
}

// calls_v2.transcript is jsonb written as { text: "<flat string>" } by the
// end-of-call webhook. Older rows may be a raw string. Normalize both.
function transcriptText(t: unknown): string {
  if (!t) return "";
  if (typeof t === "string") return t;
  if (typeof t === "object") {
    const text = (t as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

interface RawCallRow {
  id: string;
  campaign_id: string;
  created_at: string;
  duration_seconds: number | null;
  status: string;
  goal_reached: boolean | null;
  transcript: unknown;
  recording_url: unknown;
  campaigns_v2:
    | { name: string | null; is_test: boolean | null }
    | { name: string | null; is_test: boolean | null }[]
    | null;
}

function campaignBrief(row: RawCallRow): { name: string; isTest: boolean } {
  const c = row.campaigns_v2;
  const obj = Array.isArray(c) ? c[0] : c;
  return { name: obj?.name ?? "—", isTest: Boolean(obj?.is_test) };
}

const SUPABASE_PAGE = 1000; // PostgREST default max-rows

// Pull every call that HAS a transcript (the only ones worth reviewing), paging
// past the 1000-row cap. Optionally scoped to a set of campaign ids.
// NOTE: classify-on-read is fine at PoC volume (~800 calls). If labelable calls
// grow past a few thousand, denormalize a boolean "real_conversation" column at
// write time instead of fetching every transcript here.
async function fetchLabelableCalls(campaignIds: string[] | null): Promise<RawCallRow[]> {
  const out: RawCallRow[] = [];
  for (let from = 0; ; from += SUPABASE_PAGE) {
    let q = supabaseAdmin
      .from("calls_v2")
      .select(
        "id, campaign_id, created_at, duration_seconds, status, goal_reached, transcript, recording_url, campaigns_v2!campaign_id(name, is_test)",
      )
      .not("transcript", "is", null);
    if (campaignIds) q = q.in("campaign_id", campaignIds);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(from, from + SUPABASE_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as RawCallRow[];
    out.push(...rows);
    if (rows.length < SUPABASE_PAGE) break;
  }
  return out;
}

async function testCampaignIds(): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("campaigns_v2").select("id").eq("is_test", true);
  if (error) throw error;
  return (data ?? []).map((c) => c.id as string);
}

// This reviewer's labels for a bounded set of call ids (used per-campaign).
async function labelsByCall(callIds: string[], labeledBy: string): Promise<Map<string, CallLabel>> {
  const map = new Map<string, CallLabel>();
  if (callIds.length === 0) return map;
  const { data, error } = await supabaseAdmin
    .from("call_labels")
    .select("call_id, verdict, reason, labeled_by, updated_at")
    .eq("labeled_by", labeledBy)
    .in("call_id", callIds);
  if (error) throw error;
  for (const l of data ?? []) {
    map.set(l.call_id as string, {
      verdict: l.verdict as Verdict,
      reason: (l.reason as string | null) ?? null,
      labeledBy: l.labeled_by as string,
      updatedAt: l.updated_at as string,
    });
  }
  return map;
}

/**
 * Per-campaign aggregate for the Reviews landing list: how many real
 * conversations, how many the system marked goal-reached, and how many this
 * reviewer has labeled. Campaigns with zero real conversations are omitted.
 */
export async function listReviewCampaigns(opts: {
  labeledBy: string;
  testOnly?: boolean;
}): Promise<ReviewCampaign[]> {
  let campaignIds: string[] | null = null;
  if (opts.testOnly) {
    campaignIds = await testCampaignIds();
    if (campaignIds.length === 0) return [];
  }

  const calls = await fetchLabelableCalls(campaignIds);

  const byCampaign = new Map<string, ReviewCampaign>();
  const callCampaign = new Map<string, string>();
  for (const c of calls) {
    if (!hasRealConversation(transcriptText(c.transcript))) continue;
    callCampaign.set(c.id, c.campaign_id);
    const brief = campaignBrief(c);
    let agg = byCampaign.get(c.campaign_id);
    if (!agg) {
      agg = {
        campaignId: c.campaign_id,
        campaignName: brief.name,
        isTest: brief.isTest,
        conversationCount: 0,
        goalReachedCount: 0,
        labeledCount: 0,
      };
      byCampaign.set(c.campaign_id, agg);
    }
    agg.conversationCount += 1;
    if (c.goal_reached === true) agg.goalReachedCount += 1;
  }

  // This reviewer's labels (a small set — they're just starting), mapped to the
  // in-scope campaigns. Avoids a giant .in() over every labelable call id.
  const { data: labels, error: lErr } = await supabaseAdmin
    .from("call_labels")
    .select("call_id")
    .eq("labeled_by", opts.labeledBy);
  if (lErr) throw lErr;
  for (const l of labels ?? []) {
    const campId = callCampaign.get(l.call_id as string);
    if (!campId) continue;
    const agg = byCampaign.get(campId);
    if (agg) agg.labeledCount += 1;
  }

  return Array.from(byCampaign.values()).sort((a, b) => b.conversationCount - a.conversationCount);
}

/**
 * The real conversations for one campaign (drill-down), each with this
 * reviewer's existing label + a playable audio URL when a recording exists.
 * Bounded by one campaign's call volume, so no pagination needed.
 */
export async function listReviewQueue(opts: {
  labeledBy: string;
  campaignId?: string;
  testOnly?: boolean;
}): Promise<{ items: ReviewQueueItem[]; total: number }> {
  let campaignIds: string[] | null = null;
  if (opts.campaignId) {
    campaignIds = [opts.campaignId];
  } else if (opts.testOnly) {
    campaignIds = await testCampaignIds();
    if (campaignIds.length === 0) return { items: [], total: 0 };
  }

  const calls = await fetchLabelableCalls(campaignIds);
  const real = calls.filter((c) => hasRealConversation(transcriptText(c.transcript)));
  const labelMap = await labelsByCall(real.map((c) => c.id), opts.labeledBy);

  const items: ReviewQueueItem[] = real.map((c) => {
    const brief = campaignBrief(c);
    return {
      callId: c.id,
      campaignId: c.campaign_id,
      campaignName: brief.name,
      isTest: brief.isTest,
      createdAt: c.created_at,
      durationSeconds: c.duration_seconds,
      status: c.status,
      goalReached: c.goal_reached,
      transcript: transcriptText(c.transcript),
      audioUrl: audioUrlFor(c.recording_url),
      yourLabel: labelMap.get(c.id) ?? null,
    };
  });

  return { items, total: items.length };
}

/**
 * Insert or update this reviewer's verdict for a call (one editable label per
 * reviewer per call, enforced by unique(call_id, labeled_by)).
 */
export async function upsertLabel(input: {
  callId: string;
  verdict: Verdict;
  reason?: string | null;
  labeledBy: string;
}): Promise<CallLabel & { callId: string }> {
  if (!VERDICTS.includes(input.verdict)) {
    throw new Error(`Invalid verdict: ${String(input.verdict)}`);
  }
  const { data, error } = await supabaseAdmin
    .from("call_labels")
    .upsert(
      {
        call_id: input.callId,
        verdict: input.verdict,
        reason: input.reason ?? null,
        labeled_by: input.labeledBy,
      },
      { onConflict: "call_id,labeled_by" },
    )
    .select("call_id, verdict, reason, labeled_by, updated_at")
    .single();
  if (error || !data) throw error ?? new Error("Upsert failed");
  return {
    callId: data.call_id as string,
    verdict: data.verdict as Verdict,
    reason: (data.reason as string | null) ?? null,
    labeledBy: data.labeled_by as string,
    updatedAt: data.updated_at as string,
  };
}
