import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  deriveAttemptTag,
  type AttemptTag,
  type ContactTag,
  type DashCallRow,
} from "@/lib/dashboardAnalytics";

/**
 * GET /api/campaigns-v2/[id]/export-metadata?type=<filter>
 *
 * Returns a campaign's leads + attempts + SMS bodies + recording URLs in a
 * single Supabase query. Powers the client-side export hook (Phase 3) which
 * compiles CSVs, per-call transcript .txt bundles, and (for audio bundles)
 * downloads files through the /api/recordings/proxy route to bypass Vapi CDN
 * CORS.
 *
 * Filter set (UNIFIED taxonomy — same per-call tag rules as the
 * dashboardAnalytics CONTRACT). Each call is tagged via deriveAttemptTag; the
 * lead's CONTACT tag (funnel-furthest attempt tag) drives the filter, so a
 * category keeps the contacts whose overall outcome matches:
 *   all                  no filter
 *   positive             Positive response  (goal_reached on a reached call)
 *   neutral              Neutral            (reached, no goal/decline, not short)
 *   declined             Declined           (contact outcome = 'declined_offer')
 *   early_hangup         Early hangup       (reached, < EARLY_HANGUP_SEC, no goal)
 *   voicemail            Voicemail detected (reached, voicemail === true)
 *   unreachable          Unreachable        (no connected attempt)
 * Note: 'awaiting_retry' / 'wrong_number' contacts (no calls) only ever match
 * the 'all' category — there is no per-attempt tag for them.
 *
 * Auth: relies on Basic Auth middleware. Same-origin guard mirrors
 * campaigns-v2/[id]/route.ts to block external tooling.
 */
// Export categories = "all" + the 6 per-attempt AttemptTag values (unified taxonomy).
type ExportType = "all" | AttemptTag;

const VALID_TYPES: readonly ExportType[] = [
  "all",
  "positive",
  "neutral",
  "declined",
  "early_hangup",
  "voicemail",
  "unreachable",
];

// Contact-tag priority: funnel-furthest among a lead's attempt tags wins.
// MUST match computeCallRecords' CONTACT_TAG_PRIORITY in dashboardAnalytics.ts.
const CONTACT_TAG_PRIORITY: AttemptTag[] = [
  "positive",
  "declined",
  "neutral",
  "early_hangup",
  "voicemail",
  "unreachable",
];

type RawCall = {
  status: string;
  voicemail: boolean | null;
  duration_seconds: number | null;
  goal_reached: boolean | null;
  transcript: { text?: string } | null;
  recording_url: string | null;
  created_at: string;
};

type RawSms = {
  body: string;
  status: string;
  provider_message_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

type RawNumber = {
  phone_e164: string;
  outcome: string;
  attempt_count: number;
  last_attempted_at: string | null;
  calls: RawCall[] | null;
  sms_messages: RawSms[] | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Origin guard — block external tooling. Substring match (the prior
  // `origin.includes(host)`) was unsafe because hosts like
  // `evil-voizo-eight.vercel.app` contain `voizo-eight.vercel.app` as a
  // substring and bypassed the check. Parse Origin and compare hostnames
  // exactly. Missing Origin is allowed (browsers omit it on same-origin
  // GETs — read-only GET endpoint so leniency is intentional, matches the
  // csrf-origin-check-get-lenient guidance).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { id: campaignId } = await params;
  if (!campaignId || typeof campaignId !== "string" || campaignId.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  const typeParam = new URL(request.url).searchParams.get("type") ?? "all";
  const type: ExportType = VALID_TYPES.includes(typeParam as ExportType)
    ? (typeParam as ExportType)
    : "all";

  // Single literal SELECT string (the .select() inference requires one literal —
  // no concatenation). `voicemail` + `duration_seconds` are required so each
  // call can be tagged with the unified taxonomy POST-FETCH (the filter is a
  // per-call tag rule, not an outcome enum, so it can't be a server WHERE).
  const query = supabaseAdmin
    .from("campaign_numbers_v2")
    .select(
      `
      phone_e164,
      outcome,
      attempt_count,
      last_attempted_at,
      calls:calls_v2 (
        status,
        voicemail,
        duration_seconds,
        goal_reached,
        transcript,
        recording_url,
        created_at
      ),
      sms_messages:sms_messages_v2 (
        body,
        status,
        provider_message_id,
        error_message,
        created_at,
        updated_at
      )
    `,
    )
    .eq("campaign_id", campaignId)
    // Explicit upper bound. PostgREST defaults to 1000 rows when no range is
    // requested, which silently truncates exports for any campaign with >1000
    // leads. 10k is a generous PoC ceiling — anything larger should paginate
    // (separate follow-up). Note: this caps the lead (campaign_numbers_v2)
    // rows; embedded calls_v2 / sms_messages_v2 arrays are not separately
    // bounded per PostgREST behavior.
    .range(0, 9999);

  const { data: numbers, error } = await query;
  if (error) {
    // Log server-side with full detail; return generic message to the
    // client to avoid leaking column / constraint / RLS hints. Behind
    // Basic Auth so impact is bounded, but least-disclosure is the rule.
    console.error("[export-metadata] supabase query failed:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  let processed = ((numbers as unknown as RawNumber[] | null) ?? []).map((n) => {
    const sortedCalls = Array.isArray(n.calls)
      ? [...n.calls].sort(
          (a, b) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        )
      : [];

    // Per-call tag via the SHARED contract. `declinedContact` is true when the
    // CONTACT's outcome is an explicit decline — same rule deriveAttemptTag wants.
    const declinedContact = (n.outcome ?? "") === "declined_offer";
    const callTags: AttemptTag[] = sortedCalls.map((c) =>
      deriveAttemptTag(
        {
          // deriveAttemptTag only reads status / voicemail / goal_reached /
          // duration_seconds; campaign_id is required by the DashCallRow shape.
          campaign_id: campaignId,
          status: c.status,
          voicemail: c.voicemail,
          goal_reached: c.goal_reached,
          duration_seconds: c.duration_seconds,
        } as DashCallRow,
        declinedContact,
      ),
    );

    // CONTACT tag: funnel-furthest attempt tag wins; numbers with no calls have
    // no per-attempt tag (they only ever match "all").
    const present = new Set(callTags);
    const contactTag: ContactTag | null =
      callTags.length === 0
        ? null
        : CONTACT_TAG_PRIORITY.find((p) => present.has(p)) ?? "unreachable";

    return {
      phone: n.phone_e164,
      outcome: n.outcome,
      attemptCount: n.attempt_count,
      lastAttemptedAt: n.last_attempted_at,
      contactTag,
      attempts: sortedCalls.map((c, idx) => ({
        attemptNumber: idx + 1,
        status: c.status,
        tag: callTags[idx],
        durationSeconds: c.duration_seconds,
        goalReached: c.goal_reached,
        transcript: c.transcript?.text ?? null,
        recordingUrl: c.recording_url,
        createdAt: c.created_at,
      })),
      smsMessages: Array.isArray(n.sms_messages)
        ? n.sms_messages.map((s) => ({
            body: s.body,
            status: s.status,
            providerMessageId: s.provider_message_id,
            errorMessage: s.error_message,
            createdAt: s.created_at,
            updatedAt: s.updated_at,
          }))
        : [],
    };
  });

  // Filter by the requested category. "all" = no filter. Otherwise a contact
  // matches when its funnel-furthest (contact) tag === the category — the unified
  // per-call taxonomy, not the old outcome-enum buckets.
  if (type !== "all") {
    processed = processed.filter((p) => p.contactTag === type);
  }

  return NextResponse.json({
    campaignId,
    type,
    count: processed.length,
    data: processed,
  });
}
