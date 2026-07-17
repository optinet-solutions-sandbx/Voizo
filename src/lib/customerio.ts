/**
 * Customer.io App API client.
 *
 * Used to browse segments and fetch member profiles for the Campaign V2
 * segment-import feature (requested by Chris 2026-04-16 23:09).
 *
 * Server-side only — NEVER import from client components. The App API key
 * grants read access to all customer data; it cannot ship to the browser.
 *
 * Manifesto compliance:
 * - Server-only secret (§6 Secrets)
 * - Env vars validated at call time, not module init — dashboard boots even if
 *   Customer.io isn't configured yet (§2 Zero Trust, pragmatic variant)
 * - Provider-agnostic: the UI talks to our API routes, which call this client.
 *   If Customer.io is replaced, only this file changes.
 *
 * API docs: https://customer.io/docs/api/app/
 * Auth: Bearer token (the App API Key, not the Tracking key)
 * Rate limit: 10 requests/second on App API
 */

const APP_API_KEY = process.env.CUSTOMERIO_APP_API_KEY;
const REGION = (process.env.CUSTOMERIO_API_REGION || "us").toLowerCase();

// Base URL differs by region. Customer.io hosts US and EU separately.
const BASE_URL = REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";

/** Pre-flight check. Returns error message if not configured, null if ready. */
export function getCustomerIOConfigError(): string | null {
  if (!APP_API_KEY) return "CUSTOMERIO_APP_API_KEY is not set";
  if (REGION !== "us" && REGION !== "eu") {
    return `CUSTOMERIO_API_REGION must be 'us' or 'eu' (got '${REGION}')`;
  }
  return null;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface CustomerIOSegment {
  id: number;
  name: string;
  /** 'data-driven' (auto-updated by rules) or 'manual' (managed via API/CSV) */
  type: string;
  created: number; // unix timestamp seconds
  updated: number;
}

export interface CustomerIOSegmentMember {
  /** Customer.io internal ID — always present, most reliable for follow-up lookups */
  cio_id: string;
  /** Customer's email address (if workspace uses email identity) */
  email?: string;
  /** Customer's workspace-scoped custom ID (e.g. "lucky7even:158491") */
  id?: string;
}

export interface CustomerIOCustomer {
  id: string;
  email?: string | null;
  attributes: Record<string, unknown>;
}

export type CustomerIOResult<T> =
  | { success: true; data: T; error: null }
  | { success: false; data: null; error: string };

// ── Internal helper ──────────────────────────────────────────────────────────

async function customerioFetch<T>(path: string): Promise<CustomerIOResult<T>> {
  const configError = getCustomerIOConfigError();
  if (configError) return { success: false, data: null, error: configError };

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${APP_API_KEY}`,
      },
      // Don't cache — segments can change between calls
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      return {
        success: false,
        data: null,
        error: `Customer.io ${response.status}: ${body.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as T;
    return { success: true, data, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, data: null, error: `Network error: ${message}` };
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List all segments in the Customer.io workspace.
 *
 * Fast — single call, returns all segments at once.
 */
export async function listSegments(): Promise<CustomerIOResult<CustomerIOSegment[]>> {
  type Response = { segments: CustomerIOSegment[] };
  const result = await customerioFetch<Response>("/v1/segments");
  if (!result.success) return result;
  return { success: true, data: result.data.segments ?? [], error: null };
}

/**
 * Get the member IDs in a segment.
 *
 * Paginated. Pass `start` (token from previous response) to get the next page.
 * Default limit is 1000; max is 1000. Each call returns a `next` token if more
 * results exist.
 *
 * This returns IDs only. To get names/phones, call getCustomerAttributes() per ID.
 */
export async function getSegmentMembers(
  segmentId: number,
  options: { start?: string; limit?: number } = {},
): Promise<CustomerIOResult<{ identifiers: CustomerIOSegmentMember[]; next: string | null }>> {
  const limit = Math.min(options.limit ?? 1000, 1000);
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.start) params.set("start", options.start);

  // Customer.io returns identifiers as objects with cio_id + email + id fields.
  // The shape depends on the workspace's identity configuration (Lucky7even
  // uses the full triple).
  type Response = { identifiers: CustomerIOSegmentMember[]; next?: string };
  const result = await customerioFetch<Response>(
    `/v1/segments/${segmentId}/membership?${params.toString()}`,
  );
  if (!result.success) return result;

  // Normalize `next` — Customer.io returns empty string "" when there are no
  // more pages, but we want null for cleaner consumer checks.
  const next = result.data.next && result.data.next.length > 0 ? result.data.next : null;

  return {
    success: true,
    data: {
      identifiers: result.data.identifiers ?? [],
      next,
    },
    error: null,
  };
}

/**
 * Get a customer's full attribute set (name, email, phone, custom fields).
 *
 * Pass the customer's identifier — either the workspace-scoped `id`
 * (e.g. "lucky7even:158491") if the workspace uses ID-based identity,
 * OR `cio_<cio_id>` if the workspace uses cio_id-based identity.
 *
 * The caller is responsible for picking the right identifier. URL-encoding
 * is handled internally (needed for characters like `:` in workspace IDs).
 *
 * Performance: one call per customer. At Customer.io's 10 req/sec rate limit,
 * fetching 1000 customers takes ~100 seconds. Callers should paginate the UI
 * to avoid blocking on full-segment fetches.
 */
export async function getCustomerAttributes(
  identifier: string,
): Promise<CustomerIOResult<CustomerIOCustomer>> {
  type Response = { customer: { id: string; attributes: Record<string, unknown> } };
  const encoded = encodeURIComponent(identifier);
  const result = await customerioFetch<Response>(`/v1/customers/${encoded}/attributes`);
  if (!result.success) return result;

  const attrs = result.data.customer?.attributes ?? {};
  return {
    success: true,
    data: {
      id: result.data.customer?.id ?? identifier,
      email: (attrs.email as string) ?? null,
      attributes: attrs,
    },
    error: null,
  };
}

// ── Segment phone fetch (paginated, rate-limited, identifier-fallback) ───────
//
// Extracted from src/app/api/campaigns-v2/[id]/duplicate/route.ts on 2026-05-18
// when Step 6 (Manual segment refresh) became the second caller. Both the
// duplicate route and the refresh-segment route call fetchSegmentPhones; Step 7
// (Resume-diff) will be the third.
//
// The older /api/customerio/segments/[segmentId]/members route still has its
// own inline copy of chunkedPromiseAll + lookupMemberProfileWithFallback +
// extractPhone — it returns full Member objects with name + email + phone for
// the create-flow preview table, not just phones. Different shape, kept
// separate to avoid an over-eager refactor. If that diverges from this lib in
// future, reconcile.
//
// Third consumer (2026-07-10, VOZ-132): the realtime poll (scheduler/
// realtimePoll.ts) uses getSegmentMembers + lookupMemberProfileWithFallback +
// extractPhoneFromAttrs directly — it must NOT use fetchSegmentPhones, which
// re-looks-up EVERY member's profile on every call (the poll runs per minute
// and only new members may cost a profile request).

/** Phone-attribute keys to try, in priority order. Customer.io workspaces use
 *  different field names; the create-flow originally surveyed 6 variants. */
const PHONE_ATTRIBUTE_KEYS = [
  "phone",
  "phone_number",
  "mobile",
  "mobile_number",
  "cell",
  "telephone",
] as const;

export function extractPhoneFromAttrs(attrs: Record<string, unknown>): string | null {
  for (const key of PHONE_ATTRIBUTE_KEYS) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** Same idea for the player's name (greet-by-name Ramp 1, 2026-07-17): prefer a
 *  full-name attribute, else compose first + last. Returned RAW — hygiene for
 *  speech happens at the boundary (playerName.cleanFirstName). Mirrors the
 *  members route's inline extractName (kept separate there by its own comment). */
export function extractNameFromAttrs(attrs: Record<string, unknown>): string | null {
  const full = attrs.full_name ?? attrs.name;
  if (typeof full === "string" && full.trim().length > 0) return full.trim();
  const parts = [attrs.first_name, attrs.last_name]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Throttled fan-out to respect customer.io's 10 req/sec per-workspace rate
 * limit. 8 calls per chunk with 150ms pauses keeps worst-case burst safely
 * under cap while completing a 100-member batch in ~10-15s.
 */
export async function chunkedPromiseAll<T, R>(
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
 * Identifier-fallback profile lookup. Customer.io's segment-membership and
 * customer-profile tables can be inconsistent — a member's workspace `id`
 * exists in the segment but not in /customers. Try id → cio_<cio_id> → email
 * in order; only return failure when ALL identifiers fail. Closes the
 * 2026-05-13 "Glenda" silent-drop bug.
 */
export async function lookupMemberProfileWithFallback(
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
  }
  return { success: false, data: null, error: lastError };
}

/**
 * Paginated fetch of all RAW phone strings in a customer.io segment.
 *
 * Loops getSegmentMembers with the `next` cursor (1000 per page), fan-outs
 * profile lookups via chunkedPromiseAll, extracts phones via attribute-key
 * variants. Returns the raw phone strings (no normalization) — callers are
 * responsible for E.164 normalization (typically via parsePhoneList).
 *
 * Safety cap: 10 pages = 10000 members max. Phase 1 PoC scale is <500 typical.
 *
 * Used by Step 5b (Duplicate) and Step 6 (Manual segment refresh). Step 7
 * (Resume-diff segment-membership check) will be the third caller.
 */
export async function fetchSegmentPhones(segmentId: number): Promise<
  | { ok: true; phones: string[]; entries: Array<{ phone: string; name: string | null }>; sampled: number }
  | { ok: false; status: number; error: string }
> {
  const PAGE_CAP = 10;
  const allRawPhones: string[] = [];
  // Raw {phone, name} pairs (greet-by-name Ramp 1): the profile payload we
  // already fetch carries the name — zero extra Customer.io calls. `phones`
  // is kept unchanged for existing callers; name-aware callers join entries
  // to their normalized inserts via nameByE164 (campaignV2Shared).
  const allEntries: Array<{ phone: string; name: string | null }> = [];
  let cursor: string | undefined;
  let pages = 0;

  while (pages < PAGE_CAP) {
    const batchResult = await getSegmentMembers(segmentId, { start: cursor, limit: 1000 });
    if (!batchResult.success) {
      return {
        ok: false,
        status: batchResult.error.includes("CUSTOMERIO_APP_API_KEY") ? 500 : 502,
        error: batchResult.error,
      };
    }

    const profiles = await chunkedPromiseAll(
      batchResult.data.identifiers,
      8,
      lookupMemberProfileWithFallback,
    );

    for (const profile of profiles) {
      if (!profile.success) continue;
      const phone = extractPhoneFromAttrs(profile.data.attributes);
      if (phone) {
        allRawPhones.push(phone);
        allEntries.push({ phone, name: extractNameFromAttrs(profile.data.attributes) });
      }
    }

    pages++;
    if (!batchResult.data.next) break;
    cursor = batchResult.data.next;
  }

  return { ok: true, phones: allRawPhones, entries: allEntries, sampled: allRawPhones.length };
}
