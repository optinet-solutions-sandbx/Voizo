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
  if (!APP_API_KEY) return "CUSTOMERIO_APP_API_KEY is not set in .env.local";
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
