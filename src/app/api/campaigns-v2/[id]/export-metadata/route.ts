import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

/**
 * GET /api/campaigns-v2/[id]/export-metadata?type=<filter>
 *
 * Returns a campaign's leads + attempts + SMS bodies + recording URLs in a
 * single Supabase query. Powers the client-side export hook (Phase 3) which
 * compiles CSVs and (for audio bundles) downloads files through the
 * /api/recordings/proxy route to bypass Vapi CDN CORS.
 *
 * Filter set (6 categories — mirrors what the campaign detail UI already
 * surfaces today, see campaigns/v2/[id]/page.tsx OUTCOME_DISPLAY_ORDER):
 *   all                          no filter
 *   sms_sent                     outcome = 'sent_sms'
 *   not_interested_or_declined   outcome IN ('not_interested','declined_offer')
 *   voicemail                    JS-side: any joined call has status='voicemail'
 *   unreached_or_retry           outcome IN ('unreached','pending_retry')
 *   wrong_number                 outcome = 'wrong_number'
 *
 * Auth: relies on Basic Auth middleware. Same-origin guard mirrors
 * campaigns-v2/[id]/route.ts to block external tooling.
 */
type ExportType =
  | "all"
  | "sms_sent"
  | "not_interested_or_declined"
  | "voicemail"
  | "unreached_or_retry"
  | "wrong_number";

const VALID_TYPES: readonly ExportType[] = [
  "all",
  "sms_sent",
  "not_interested_or_declined",
  "voicemail",
  "unreached_or_retry",
  "wrong_number",
];

type RawCall = {
  status: string;
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

  let query = supabaseAdmin
    .from("campaign_numbers_v2")
    .select(
      `
      phone_e164,
      outcome,
      attempt_count,
      last_attempted_at,
      calls:calls_v2 (
        status,
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
    .eq("campaign_id", campaignId);

  if (type === "sms_sent") {
    query = query.eq("outcome", "sent_sms");
  } else if (type === "not_interested_or_declined") {
    query = query.in("outcome", ["not_interested", "declined_offer"]);
  } else if (type === "unreached_or_retry") {
    query = query.in("outcome", ["unreached", "pending_retry"]);
  } else if (type === "wrong_number") {
    query = query.eq("outcome", "wrong_number");
  }

  // Explicit upper bound. PostgREST defaults to 1000 rows when no range is
  // requested, which silently truncates exports for any campaign with >1000
  // leads matching the filter. 10k is a generous PoC ceiling — anything
  // larger should paginate (separate follow-up). Note: this caps the lead
  // (campaign_numbers_v2) rows; embedded calls_v2 / sms_messages_v2 arrays
  // are not separately bounded per PostgREST behavior.
  query = query.range(0, 9999);

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

    return {
      phone: n.phone_e164,
      outcome: n.outcome,
      attemptCount: n.attempt_count,
      lastAttemptedAt: n.last_attempted_at,
      attempts: sortedCalls.map((c, idx) => ({
        attemptNumber: idx + 1,
        status: c.status,
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

  if (type === "voicemail") {
    processed = processed.filter((p) =>
      p.attempts.some((a) => a.status === "voicemail"),
    );
  }

  return NextResponse.json({
    campaignId,
    type,
    count: processed.length,
    data: processed,
  });
}
