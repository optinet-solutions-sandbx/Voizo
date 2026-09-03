import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { isSmsSent } from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/campaigns/phone-lookup?phone=<free text>
 *
 * Player-number lookup for the Campaign Performance section (Val 2026-08-07):
 * which campaigns hold this number, and what happened to it in each — called
 * (attempt_count), contact outcome, and whether a text was sent. The client
 * intersects the returned campaign ids with its active filters, which is the
 * ticket's "filters + phone number interaction" requirement.
 *
 * Matching mirrors /api/dashboard/analytics's phone lookup exactly (digits-only
 * needle, substring ilike on phone_e164) so the two sections can never disagree
 * about whether a number "exists". Read-only; lenient same-origin guard (GET).
 */
const IN_CHUNK = 150; // stay far below the undici header cap (project rule: chunk .in() at ≤200)
const MATCH_CAP = 500;

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

  // Two shapes of query (2026-09-03, the one search box in Campaign Performance):
  //   ?phone=<digits>  — the original: substring match on phone_e164, 4-digit floor.
  //   ?name=<text>     — a player's display name, substring match, 2-character floor. The
  //                      dashboard mockup's box finds a player "by number or name", and the
  //                      Audience members route already matches display_name the same way.
  const params = new URL(request.url).searchParams;
  const phone = (params.get("phone") ?? "").trim();
  const name = (params.get("name") ?? "").trim();
  let needle: string;
  let matchColumn: "phone_e164" | "display_name";
  if (name) {
    if (name.length < 2) return NextResponse.json({ error: "Enter at least 2 characters of the name." }, { status: 400 });
    needle = name;
    matchColumn = "display_name";
  } else {
    needle = phone.replace(/[^\d+]/g, "");
    if (needle.length < 4) {
      // Sub-4-digit needles match half the table — refuse loudly instead of
      // returning a misleading MATCH_CAP-truncated everything.
      return NextResponse.json({ error: "Enter at least 4 digits of the number." }, { status: 400 });
    }
    matchColumn = "phone_e164";
  }

  const { data: nums, error } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("id, campaign_id, phone_e164, display_name, outcome, attempt_count, last_attempted_at")
    .ilike(matchColumn, `%${needle}%`)
    .limit(MATCH_CAP);
  if (error) {
    console.error("[campaigns/phone-lookup] query failed:", error.message);
    return NextResponse.json({ error: "Lookup failed" }, { status: 500 });
  }

  // smsSent per matched number — sent|delivered texts by campaign_number_id.
  const smsSentNumberIds = new Set<string>();
  const ids = (nums ?? []).map((n) => n.id as string);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data: sms, error: smsErr } = await supabaseAdmin
      .from("sms_messages_v2")
      .select("campaign_number_id, status")
      .in("campaign_number_id", ids.slice(i, i + IN_CHUNK));
    if (smsErr) {
      console.error("[campaigns/phone-lookup] sms query failed:", smsErr.message);
      break; // matches still useful without the sms badge — degrade, don't 500
    }
    for (const m of sms ?? []) {
      if (m.campaign_number_id && isSmsSent(m.status as string)) smsSentNumberIds.add(m.campaign_number_id as string);
    }
  }

  return NextResponse.json({
    query: needle,
    truncated: (nums ?? []).length >= MATCH_CAP,
    matches: (nums ?? []).map((n) => ({
      numberId: n.id,
      campaignId: n.campaign_id,
      phone: n.phone_e164,
      displayName: n.display_name ?? null,
      outcome: n.outcome ?? null,
      attemptCount: n.attempt_count ?? 0,
      lastAttemptedAt: n.last_attempted_at ?? null,
      smsSent: smsSentNumberIds.has(n.id as string),
    })),
  });
}
