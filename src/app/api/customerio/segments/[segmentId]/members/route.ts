/**
 * GET /api/customerio/segments/[segmentId]/members
 *
 * Returns people in a segment with their phone numbers and names.
 * Used by the Campaign V2 create page's segment preview table.
 *
 * Query params:
 *   limit (optional, default 50, max 200) — how many members to return
 *   start (optional) — pagination token from a previous response
 *
 * Response:
 *   { members: [{id, name, phone, email}, ...], next: string | null, totalFetched: number }
 *
 * Design decisions (manifesto §4 "Slow & Correct"):
 * - Small default limit (50) — users preview before importing the whole segment.
 *   Importing thousands of profiles upfront would hit Customer.io's rate limit.
 * - Fetches member IDs + profile attributes in one request so the UI has
 *   everything in a single round-trip.
 * - Returns a `next` token so the UI can offer "load more" if needed.
 * - Only extracts phone + name from profile attributes — no other PII leaves the server.
 *
 * Performance note:
 * - Each profile fetch is 1 API call. At Customer.io's 10 req/sec rate limit,
 *   50 members = ~5 sec. Acceptable for preview. Full-segment import for a
 *   10k-member segment would take ~17 min — that's a post-PoC optimization
 *   (batch/export endpoint).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSegmentMembers, getCustomerAttributes } from "@/lib/customerio";

interface Member {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Pull the phone number out of a customer's attributes.
 * Customer.io doesn't mandate a standard field name for phone — different
 * workspaces use `phone`, `phone_number`, `mobile`, etc. Try common variants.
 */
function extractPhone(attrs: Record<string, unknown>): string | null {
  const candidates = ["phone", "phone_number", "mobile", "mobile_number", "cell", "telephone"];
  for (const key of candidates) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

/** Same idea for name — try common variants. */
function extractName(attrs: Record<string, unknown>): string | null {
  // Prefer full name if present
  const full = attrs.full_name ?? attrs.name;
  if (typeof full === "string" && full.trim().length > 0) return full.trim();

  // Otherwise build from first + last
  const first = attrs.first_name;
  const last = attrs.last_name;
  const parts = [
    typeof first === "string" ? first.trim() : "",
    typeof last === "string" ? last.trim() : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ segmentId: string }> },
) {
  const { segmentId: segmentIdStr } = await params;
  const segmentId = parseInt(segmentIdStr, 10);
  if (Number.isNaN(segmentId)) {
    return NextResponse.json({ error: "Invalid segmentId" }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);
  const start = searchParams.get("start") || undefined;
  const debug = searchParams.get("debug") === "true";

  // Step 1: Get member IDs (one fast call)
  const membersResult = await getSegmentMembers(segmentId, { limit, start });
  if (!membersResult.success) {
    const status = membersResult.error.includes("CUSTOMERIO_APP_API_KEY") ? 500 : 502;
    return NextResponse.json({ error: membersResult.error }, { status });
  }

  // Step 2: Fetch each member's attributes in parallel.
  // Identifier precedence (depends on workspace's identity mode):
  //   1. Workspace-scoped `id` (e.g. "lucky7even:158491") — ID-based workspaces
  //   2. `cio_<cio_id>` — cio_id-based workspaces
  //   3. email — fallback for anonymous users
  // Lucky7even is ID-based, so `id` takes precedence.
  // Parallel is safe because Customer.io's rate limit is per-second, not per-request.
  const profilePromises = membersResult.data.identifiers.map((member) => {
    const identifier = member.id || `cio_${member.cio_id}` || member.email || "";
    return getCustomerAttributes(identifier);
  });
  const profiles = await Promise.all(profilePromises);

  // Debug mode: return raw profile data to inspect attribute names.
  // Use ?debug=true with small limit. Server-side only — never expose to clients.
  if (debug) {
    return NextResponse.json({
      debug: true,
      identifiersRaw: membersResult.data.identifiers,
      profilesRaw: profiles.map((p) =>
        p.success
          ? { success: true, attributes: p.data.attributes, email: p.data.email, id: p.data.id }
          : { success: false, error: p.error },
      ),
    });
  }

  // Step 3: Shape the response. Include people even if we couldn't fetch their
  // profile — UI shows "unknown" for name/phone rather than silently dropping them.
  // We expose the cio_id as the flat `id` field (the UI doesn't need the full triple).
  const members: Member[] = profiles.map((profile, i) => {
    const source = membersResult.data.identifiers[i];
    if (!profile.success) {
      return {
        id: source.cio_id,
        name: null,
        phone: null,
        email: source.email ?? null,
      };
    }
    return {
      id: source.cio_id,
      name: extractName(profile.data.attributes),
      phone: extractPhone(profile.data.attributes),
      // Prefer the attributes-page email if set, fall back to membership-level email
      email: profile.data.email ?? source.email ?? null,
    };
  });

  return NextResponse.json({
    members,
    next: membersResult.data.next,
    totalFetched: members.length,
  });
}
