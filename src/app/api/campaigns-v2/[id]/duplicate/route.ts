import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchSegmentPhones } from "@/lib/customerio";
import { parsePhoneList, nameByE164 } from "@/lib/campaignV2Shared";
import { rejectIfCrossOrigin } from "@/lib/csrf";
import { CONTACT_OUTCOMES } from "@/lib/contactOutcomes";
import { MAX_CANDIDATES } from "@/lib/audienceLimits";
import { fetchAllRows, fetchRowsIn } from "@/lib/supabaseFetchAll";

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
    // Paged (VOZ-266): the bare select was clamped at 1000 rows, silently
    // shrinking a large source's pending list before the MAX_CANDIDATES check
    // ever saw it. failFast: a partial candidate set = a partial duplicate.
    let sourceNumbers: Array<Record<string, unknown>>;
    try {
      sourceNumbers = await fetchAllRows(
        supabaseAdmin, "campaign_numbers_v2", "phone_e164, display_name", "id",
        { column: "campaign_id", value: id },
        undefined, undefined,
        { failFast: true, inFilter: { column: "outcome", values: ["pending", "pending_retry"] } },
      );
    } catch (err) {
      console.error(`[campaigns-v2/duplicate] source numbers read failed for ${id}:`, err);
      return NextResponse.json({ error: "Failed to read source numbers" }, { status: 500 });
    }
    candidatePhones = sourceNumbers.map((r) => r.phone_e164 as string);
    for (const r of sourceNumbers) {
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

  // Chunked (VOZ-266) with loud failure. The Promise.all this replaces never
  // checked .error — and an unchunked .in() with >=1000 candidates throws
  // inside our HTTP client, so on large segments every bucket came back
  // silently EMPTY. Worst case was overlap: an empty overlap bucket means the
  // wizard prefill would happily re-dial the source's entire pending list —
  // and unlike DNC/suppression, nothing re-checks overlap at dial time.
  let overlapSet: Set<string>;
  let suppressedSet: Set<string>;
  let recentSet: Set<string>;
  try {
    const [overlapRows, suppressedRows, dncRows, recentRows] = await Promise.all([
      fetchRowsIn(supabaseAdmin, "campaign_numbers_v2", "phone_e164", "phone_e164", candidatePhones, (q) =>
        q.eq("campaign_id", id).in("outcome", ["pending", "pending_retry"]),
      ),
      fetchRowsIn(supabaseAdmin, "suppression_list", "phone_e164", "phone_e164", candidatePhones),
      fetchRowsIn(supabaseAdmin, "do_not_call", "phone_number", "phone_number", candidatePhones, (q) =>
        q.eq("archived", false),
      ),
      fetchRowsIn(supabaseAdmin, "campaign_numbers_v2", "phone_e164", "phone_e164", candidatePhones, (q) =>
        q.neq("campaign_id", id).in("outcome", CONTACT_OUTCOMES).gt("last_attempted_at", recentCutoffIso),
      ),
    ]);
    overlapSet = new Set(overlapRows.map((r) => r.phone_e164 as string));
    suppressedSet = new Set<string>([
      ...suppressedRows.map((r) => r.phone_e164 as string),
      ...dncRows.map((r) => r.phone_number as string),
    ]);
    recentSet = new Set(recentRows.map((r) => r.phone_e164 as string));
  } catch (err) {
    console.error(`[campaigns-v2/duplicate] diff queries failed for ${id}:`, err);
    return NextResponse.json({ error: "Failed to compute duplicate safety buckets" }, { status: 500 });
  }

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
