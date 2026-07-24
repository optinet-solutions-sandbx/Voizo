import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchSegmentPhones } from "@/lib/customerio";
import { parsePhoneList, nameByE164 } from "@/lib/campaignV2Shared";
import { rejectIfCrossOrigin } from "@/lib/csrf";
import { CONTACT_OUTCOMES } from "@/lib/contactOutcomes";
import { MAX_CANDIDATES } from "@/lib/audienceLimits";

/**
 * GET /api/campaigns-v2/[id]/duplicate
 *
 * Read-only prefill payload for the Duplicate-via-Wizard flow.
 *
 * Fetches the source campaign, optionally refreshes its Customer.io segment,
 * computes the overlap/suppressed/recently-called diff, applies the default
 * skip strategy (overlap + suppressed silently filtered), and returns the
 * payload that the wizard consumes on mount.
 *
 * No side effects — this endpoint NEVER creates Vapi clones, leases SIP
 * slots, or inserts campaign rows. All creation logic stays in the wizard's
 * existing handleLaunch (clone-assistant + createCampaignV2 on submit).
 *
 * Query params:
 *   ?refresh_segment=true|false   (default true)
 *
 * Restrictions:
 *   - Recurring source campaigns rejected with 400.
 *   - Candidate phone set capped at MAX_CANDIDATES (see src/lib/audienceLimits.ts).
 *
 * Plan: C:\Users\jasin\.claude\plans\new-shift-picking-gentle-puffin.md
 * Replaces the prior POST flow (create-on-commit, 3-stage modal) per the
 * 2026-05-21 redesign — operators always go through the wizard now.
 */

// Customer.io segment fetch + four parallel diff queries. 30s gives ample
// margin at PoC scale (segments <500 typical).
export const maxDuration = 30;

const RECENT_CALL_WINDOW_DAYS = 7;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const refreshSegment = url.searchParams.get("refresh_segment") !== "false";
  // skip CSV: e.g. "overlap,suppressed" or "overlap,suppressed,recent" or "" (none).
  // If the param is absent entirely, fall back to the defensive default
  // (overlap + suppressed). An explicit empty string means "skip nothing".
  // Unknown values 400 — silent drop hides client/server divergence (audit H4).
  const VALID_SKIP_VALUES: ReadonlySet<string> = new Set(["overlap", "suppressed", "recent"]);
  const skipParamRaw = url.searchParams.get("skip");
  let skipFlags: Set<string>;
  if (skipParamRaw === null) {
    skipFlags = new Set(["overlap", "suppressed"]);
  } else {
    const tokens = skipParamRaw.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = tokens.filter((t) => !VALID_SKIP_VALUES.has(t));
    if (unknown.length > 0) {
      return NextResponse.json(
        {
          error: `Invalid skip values: ${unknown.join(", ")}. Allowed: overlap, suppressed, recent`,
        },
        { status: 400 },
      );
    }
    skipFlags = new Set(tokens);
  }

  // ── 1. Read source campaign ──
  // .select() is a single string literal per feedback_supabase_select_single_literal.
  const { data: source, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select(
      "id, name, status, campaign_type, system_prompt, base_assistant_id, voice_id, segment_id, cio_workspace, timezone, call_windows, max_attempts, retry_interval_minutes, sms_enabled, sms_template, sms_on_goal_reached_only, sms_consent_mode",
    )
    .eq("id", id)
    .single();

  if (selectErr || !source) {
    return NextResponse.json({ error: "Source campaign not found" }, { status: 404 });
  }

  if (source.campaign_type === "recurring") {
    return NextResponse.json(
      { error: "Duplicating recurring campaigns is not yet supported." },
      { status: 400 },
    );
  }

  // ── 2. Determine candidate phone set ──
  // refresh_segment=true (default) + source has segment_id → fetch fresh from CIO.
  // Otherwise (no segment_id, or refresh_segment=false) → copy source's pending
  // numbers as-is. The frontend doesn't expose the toggle today; the fallback
  // path is a safety net for legacy campaigns without segment_id.
  let candidatePhones: string[];
  let candidateSource: "segment_refresh" | "source_pending";
  // Greet-by-name Ramp 1 (review finding 2026-07-17): duplicated campaigns must
  // KEEP player names — E.164 → raw name, riding the prefill to the wizard.
  let candidateNames = new Map<string, string>();

  if (refreshSegment && source.segment_id != null) {
    const segmentResult = await fetchSegmentPhones(
      source.segment_id as number,
      source.cio_workspace as string | null, // VOZ-198: fetch with THIS campaign's workspace key
    );
    if (!segmentResult.ok) {
      return NextResponse.json(
        { error: `Customer.io fetch failed: ${segmentResult.error}` },
        { status: segmentResult.status },
      );
    }
    candidatePhones = parsePhoneList(segmentResult.phones.join("\n"));
    candidateNames = nameByE164(segmentResult.entries);
    candidateSource = "segment_refresh";
  } else {
    const { data: sourceNumbers, error: numbersErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164, display_name")
      .eq("campaign_id", id)
      .in("outcome", ["pending", "pending_retry"]);
    if (numbersErr) {
      return NextResponse.json({ error: "Failed to read source numbers" }, { status: 500 });
    }
    candidatePhones = (sourceNumbers ?? []).map((r) => r.phone_e164 as string);
    for (const r of sourceNumbers ?? []) {
      const name = r.display_name as string | null;
      if (name && !candidateNames.has(r.phone_e164 as string)) candidateNames.set(r.phone_e164 as string, name);
    }
    candidateSource = "source_pending";
  }

  if (candidatePhones.length === 0) {
    return NextResponse.json(
      { error: `Candidate phone set is empty (${candidateSource}). Nothing to duplicate.` },
      { status: 400 },
    );
  }

  if (candidatePhones.length > MAX_CANDIDATES) {
    return NextResponse.json(
      {
        error:
          `Candidate set is ${candidatePhones.length} phones; current diff implementation caps at ${MAX_CANDIDATES}.`,
      },
      { status: 413 },
    );
  }

  // ── 3. Compute the three diff buckets (parallel queries) ──
  const recentCutoffIso = new Date(
    Date.now() - RECENT_CALL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [overlapRes, suppressedRes, dncRes, recentRes] = await Promise.all([
    supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .eq("campaign_id", id)
      .in("outcome", ["pending", "pending_retry"])
      .in("phone_e164", candidatePhones),
    supabaseAdmin
      .from("suppression_list")
      .select("phone_e164")
      .in("phone_e164", candidatePhones),
    supabaseAdmin
      .from("do_not_call")
      .select("phone_number")
      .eq("archived", false)
      .in("phone_number", candidatePhones),
    supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .neq("campaign_id", id)
      .in("phone_e164", candidatePhones)
      .in("outcome", CONTACT_OUTCOMES)
      .gt("last_attempted_at", recentCutoffIso),
  ]);

  const overlapSet = new Set((overlapRes.data ?? []).map((r) => r.phone_e164 as string));
  const suppressedSet = new Set<string>([
    ...((suppressedRes.data ?? []).map((r) => r.phone_e164 as string)),
    ...((dncRes.data ?? []).map((r) => r.phone_number as string)),
  ]);
  const recentSet = new Set((recentRes.data ?? []).map((r) => r.phone_e164 as string));

  // ── 4. Apply skip strategy based on query params ──
  // Per plan: modal + wizard each call this endpoint with `?skip=` set to
  // reflect operator choices. Default (no param) is overlap + suppressed —
  // never silently include DNC or double-dial candidates. Recently-called
  // is opt-in (operator toggles in modal).
  const filteredPhones = candidatePhones.filter((p) => {
    if (skipFlags.has("overlap") && overlapSet.has(p)) return false;
    if (skipFlags.has("suppressed") && suppressedSet.has(p)) return false;
    if (skipFlags.has("recent") && recentSet.has(p)) return false;
    return true;
  });

  // ── 5. Build suggested name (source.name + today's local date) ──
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const suggestedName = `${source.name as string} (${yyyy}-${mm}-${dd})`;

  // The frontend (modal + wizard) needs the actual bucket sets — not just
  // counts — to compute dial counts client-side as the operator toggles
  // skip flags without round-tripping. Return them as sorted arrays for
  // deterministic JSON.
  const sortedBucket = (s: Set<string>) => Array.from(s).sort();

  return NextResponse.json({
    source: {
      id: source.id,
      name: source.name,
      status: source.status,
      campaign_type: source.campaign_type,
      base_assistant_id: source.base_assistant_id,
      voice_id: source.voice_id,
      system_prompt: source.system_prompt,
      timezone: source.timezone,
      call_windows: source.call_windows,
      sms_enabled: source.sms_enabled,
      sms_template: source.sms_template,
      sms_on_goal_reached_only: source.sms_on_goal_reached_only,
      sms_consent_mode: source.sms_consent_mode ?? "verbal_yes",
      segment_id: source.segment_id,
    },
    prefill: {
      suggestedName,
      candidateSource,
      candidates: candidatePhones,
      overlap: sortedBucket(overlapSet),
      suppressed: sortedBucket(suppressedSet),
      recentlyCalled: sortedBucket(recentSet),
      phones: filteredPhones,          // pre-filtered per skipFlags
      appliedSkips: Array.from(skipFlags),
      // Greet-by-name Ramp 1: keyed map — unaffected by client-side re-filtering.
      names: Object.fromEntries(candidateNames),
    },
  });
}
