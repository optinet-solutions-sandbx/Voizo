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
import {
  getSegmentMembers,
  getCustomerAttributes,
  type CustomerIOSegmentMember,
  type CustomerIOCustomer,
  type CustomerIOResult,
} from "@/lib/customerio";

interface Member {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Execute async work in chunks to respect Customer.io's 10 req/sec rate limit.
 * Default: 8 calls per chunk, 150ms pause between chunks. Keeps worst-case
 * burst safely under 10/sec while still completing a 100-member segment in
 * ~10-15 seconds. Without throttling, Promise.all over 200 members fires
 * 200 simultaneous calls and trips CIO's per-second cap (429 cascade).
 */
async function chunkedPromiseAll<T, R>(
  items: T[],
  chunkSize: number,
  fn: (item: T) => Promise<R>,
  delayMs = 150,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
    if (i + chunkSize < items.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

/**
 * Look up a customer's profile via Customer.io App API with identifier
 * fallback. Customer.io segment membership and customer profiles can be
 * inconsistent: a member's workspace `id` exists in the segment but not in
 * the customers table (e.g., after re-identification, or for customers
 * imported by email only). Try id → cio_<cio_id> → email in order; only
 * return failure when ALL identifiers fail.
 *
 * Closes the 2026-05-13 "Glenda" silent-drop bug where Voizo dropped
 * customers whose primary identifier failed a profile lookup, even when
 * a fallback identifier would have succeeded. At Lucky7even scale this
 * was costing ~30-40% of every segment import.
 *
 * Each failed attempt logs a warning so we can diagnose patterns in
 * Vercel logs (e.g., "most failures are on `id`, all fall through to
 * `email`" suggests a CIO data inconsistency we should report to them).
 */
async function lookupMemberProfileWithFallback(
  member: CustomerIOSegmentMember,
): Promise<CustomerIOResult<CustomerIOCustomer>> {
  const identifiers = [
    member.id,
    member.cio_id ? `cio_${member.cio_id}` : null,
    member.email,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  if (identifiers.length === 0) {
    return { success: false, data: null, error: "No identifiers available on segment member" };
  }

  let lastError = "All identifiers exhausted";
  for (const id of identifiers) {
    const result = await getCustomerAttributes(id);
    if (result.success) return result;
    lastError = result.error;
    console.warn(
      `[customerio-importer] lookup failed for "${id.slice(0, 60)}" ` +
      `(cio_id=${member.cio_id ?? "?"}): ${result.error.slice(0, 100)}`,
    );
  }
  return { success: false, data: null, error: lastError };
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

  // Step 2: Fetch each member's attributes with throttled fan-out + identifier
  // fallback. Both characteristics matter:
  //
  // Throttling (chunkedPromiseAll, 8 per chunk + 150ms): Customer.io's App API
  // enforces a per-second rate limit (~10 req/sec/workspace). Pre-2026-05-13
  // this code used unthrottled Promise.all, which the pre-PoC volumes (segments
  // <50) hadn't tripped — but a 200-member segment fires 200 parallel calls
  // and produces 429 cascades. Throttling keeps the burst safely under cap.
  //
  // Identifier fallback (lookupMemberProfileWithFallback): try `member.id`
  // first (Lucky7even is ID-based), then `cio_<cio_id>`, then `email`. CIO's
  // segment membership and customer profile tables can be inconsistent — a
  // member's `id` is in the segment but missing from /customers. Falling back
  // captures customers we previously silently dropped (the "Glenda" bug).
  const profiles = await chunkedPromiseAll(
    membersResult.data.identifiers,
    8,
    lookupMemberProfileWithFallback,
  );

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
