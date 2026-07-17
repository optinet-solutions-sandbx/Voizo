import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { audioUrlFor, transcriptText } from "@/lib/labelData";
import { campaignContextFrom } from "@/lib/campaignContext";

/**
 * GET /api/dashboard/call-detail?numberId=<campaign_number_id>
 *
 * Every call ATTEMPT for one contact (a campaign_number), each with a playable audio URL +
 * normalized transcript — for the per-contact detail modal opened from the records tables.
 * Ordered chronologically (Attempt 1 first). Read-only; lenient origin (matches the other
 * dashboard GETs); service role. Zero call/SMS cost — recordings already exist; the audio URL
 * is the same-origin recordings proxy (reused from the reviews queue).
 *
 * Also returns the contact's CAMPAIGN CONTEXT (additive `campaign` field, 2026-07-17): which
 * campaign/agent/voice made these calls, the script name for script-mode campaigns, and the
 * campaign prompt (persona in script mode — the wizard persists it to system_prompt). A
 * contact belongs to exactly one campaign, so this is one row. Lookup failure degrades to
 * campaign:null without affecting attempts.
 */

// Base-agent name lookup, memoized per server instance. Assistant names change
// ~never; operators open many contacts of the same campaign in a row, so this
// turns N Vapi GETs into 1 per instance lifetime. Only DEFINITIVE answers are
// cached (200 with/without a name, or a 4xx = assistant gone); transient
// failures (timeout, network, 5xx) are NOT cached so one cold-start hiccup
// can't pin the clone-name fallback for the instance lifetime (review finding
// 2026-07-17). The per-open retry cost on a Vapi outage is one bounded 5s GET.
const baseNameCache = new Map<string, string | null>();
async function baseAgentName(assistantId: string): Promise<string | null> {
  if (baseNameCache.has(assistantId)) return baseNameCache.get(assistantId) ?? null;
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      const n = ((await r.json()) as { name?: unknown }).name;
      const name = typeof n === "string" && n.trim() ? n : null;
      baseNameCache.set(assistantId, name);
      return name;
    }
    if (r.status >= 400 && r.status < 500) {
      baseNameCache.set(assistantId, null); // definitive: gone/forbidden — stop asking
    }
    return null; // 5xx: transient — retry on the next open
  } catch {
    return null; // timeout/network: transient — retry on the next open
  }
}

export async function GET(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const numberId = new URL(request.url).searchParams.get("numberId");
  if (!numberId) return NextResponse.json({ error: "numberId is required" }, { status: 400 });

  // Attempts + campaign context in parallel; the campaign leg is non-fatal.
  const [{ data, error }, campaignRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select("id, created_at, duration_seconds, status, goal_reached, transcript, recording_url")
      .eq("campaign_number_id", numberId)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("campaign_numbers_v2")
      .select("display_name, campaigns_v2!campaign_id(name, vapi_assistant_name, agent_mode, script_name, system_prompt, voice_name, base_assistant_id)")
      .eq("id", numberId)
      .maybeSingle(),
  ]);

  if (error) {
    console.error("[dashboard/call-detail] query failed:", error);
    return NextResponse.json({ error: "Failed to load call detail" }, { status: 500 });
  }

  if (campaignRes.error) {
    // Degrade: the modal renders attempts without the context strip.
    console.error("[dashboard/call-detail] campaign context query failed:", campaignRes.error);
  }
  const ctx = campaignContextFrom(campaignRes.data?.campaigns_v2 ?? null);
  // Greet-by-name Ramp 1: the contact's imported name (raw, as Customer.io gave
  // it) — null for pre-migration rows and manual pastes.
  const rawName = (campaignRes.data as { display_name?: unknown } | null)?.display_name;
  const contactName = typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
  // The clone's Vapi name is just the campaign name truncated to 40 chars — useless
  // for identifying WHO the agent is. Resolve the BASE agent's human name (Val/Ernie…)
  // from base_assistant_id; fall back to the clone name for campaigns predating the
  // column. Non-fatal on any failure.
  const baseName = ctx?.baseAssistantId ? await baseAgentName(ctx.baseAssistantId) : null;
  const campaign = ctx ? { ...ctx, agentName: baseName ?? ctx.agentName } : null;

  const attempts = (data ?? []).map((c) => ({
    callId: c.id as string,
    createdAt: c.created_at as string | null,
    durationSeconds: (c.duration_seconds as number | null) ?? null,
    status: (c.status as string | null) ?? "",
    goalReached: (c.goal_reached as boolean | null) ?? null,
    transcript: transcriptText(c.transcript),
    audioUrl: audioUrlFor(c.recording_url),
  }));

  return NextResponse.json({ attempts, campaign, contactName });
}
