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
// ponytail: region stays global — both live workspaces are EU; add a
// per-workspace region map only when a non-EU workspace arrives (VOZ-198).
const BASE_URL = REGION === "eu" ? "https://api-eu.customer.io" : "https://api.customer.io";

/** The original / only workspace before VOZ-198. A NULL/absent cio_workspace
 *  on a campaigns_v2 row means this one. */
export const CIO_DEFAULT_WORKSPACE = "lucky7even";

/**
 * Resolve the App API key for a CIO workspace (VOZ-198 — Fortune Play is
 * workspace #2). Reads env at CALL time so tests can steer it and the
 * dashboard still boots unconfigured.
 *
 * Map env `CUSTOMERIO_APP_API_KEYS` = `{"lucky7even":"…","fortuneplay":"…"}` —
 * the same {workspace label → key} shape as CUSTOMERIO_WEBHOOK_SIGNING_KEYS,
 * and the labels MUST match that map + campaigns_v2.cio_workspace.
 *
 * The legacy single `CUSTOMERIO_APP_API_KEY` remains the fallback for the
 * DEFAULT workspace only. A non-default workspace never borrows another
 * workspace's key: that would silently read brand A's segment/profiles into
 * brand B's campaign — the exact cross-brand bug VOZ-198 exists to prevent.
 * Fail closed instead.
 */
/** Parse CUSTOMERIO_APP_API_KEYS at call time. Malformed/absent → {} — the
 *  default workspace still runs on the legacy key; others fail closed. */
function parseAppApiKeyMap(): Record<string, unknown> {
  const rawMap = process.env.CUSTOMERIO_APP_API_KEYS;
  if (!rawMap) return {};
  try {
    const parsed: unknown = JSON.parse(rawMap);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Which workspaces (brands) are configured — the wizard's Brand picker source
 * (VOZ-201). Returns LABELS only; keys never leave this module. Default
 * workspace first (present when the legacy key OR its map entry is usable),
 * then the other usable map labels in map order.
 */
export function listConfiguredWorkspaces(): string[] {
  const map = parseAppApiKeyMap();
  const usable = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const out: string[] = [];
  if (process.env.CUSTOMERIO_APP_API_KEY || usable(map[CIO_DEFAULT_WORKSPACE])) {
    out.push(CIO_DEFAULT_WORKSPACE);
  }
  for (const [label, key] of Object.entries(map)) {
    if (label !== CIO_DEFAULT_WORKSPACE && usable(key)) out.push(label);
  }
  return out;
}

export function resolveAppApiKey(
  workspace?: string | null,
): { key: string; error: null } | { key: null; error: string } {
  const ws = (workspace ?? "").trim() || CIO_DEFAULT_WORKSPACE;
  const map = parseAppApiKeyMap();
  const entry = map[ws];
  if (typeof entry === "string" && entry.trim().length > 0) {
    return { key: entry, error: null };
  }
  if (ws === CIO_DEFAULT_WORKSPACE) {
    const legacy = process.env.CUSTOMERIO_APP_API_KEY;
    if (legacy) return { key: legacy, error: null };
    return { key: null, error: "CUSTOMERIO_APP_API_KEY is not set" };
  }
  return { key: null, error: `CUSTOMERIO_APP_API_KEYS has no key for workspace '${ws}'` };
}

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

async function customerioFetch<T>(
  path: string,
  workspace?: string | null,
): Promise<CustomerIOResult<T>> {
  if (REGION !== "us" && REGION !== "eu") {
    return {
      success: false,
      data: null,
      error: `CUSTOMERIO_API_REGION must be 'us' or 'eu' (got '${REGION}')`,
    };
  }
  // Per-workspace key (VOZ-198): default/null → legacy key, unchanged behavior.
  const resolved = resolveAppApiKey(workspace);
  if (resolved.error !== null) return { success: false, data: null, error: resolved.error };

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${resolved.key}`,
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
export async function listSegments(
  workspace?: string | null,
): Promise<CustomerIOResult<CustomerIOSegment[]>> {
  type Response = { segments: CustomerIOSegment[] };
  const result = await customerioFetch<Response>("/v1/segments", workspace);
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
  workspace?: string | null,
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
    workspace,
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
 * Pass the customer's identifier. Without `idType`, the API treats it as the
 * workspace-scoped `id` (e.g. "lucky7even:158491") — the prod-proven default.
 * For cio_id or email addressing you MUST pass `idType` (VOZ-185): verified
 * live 2026-07-22 against the EU App API — the legacy `cio_<cio_id>` prefix
 * form 404s/400s on this endpoint, raw email 404s, while bare cio_id +
 * `?id_type=cio_id` and email + `?id_type=email` both resolve.
 *
 * URL-encoding is handled internally (needed for `:` in workspace IDs and
 * `+` in emails).
 *
 * Performance: one call per customer. At Customer.io's 10 req/sec rate limit,
 * fetching 1000 customers takes ~100 seconds. Callers should paginate the UI
 * to avoid blocking on full-segment fetches.
 */
export async function getCustomerAttributes(
  identifier: string,
  idType?: "cio_id" | "email",
  workspace?: string | null,
): Promise<CustomerIOResult<CustomerIOCustomer>> {
  type Response = { customer: { id: string; attributes: Record<string, unknown> } };
  const encoded = encodeURIComponent(identifier);
  const query = idType ? `?id_type=${idType}` : "";
  const result = await customerioFetch<Response>(
    `/v1/customers/${encoded}/attributes${query}`,
    workspace,
  );
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

/** One rung of the profile-lookup ladder: identifier + how to address it. */
export interface LookupIdentifier {
  identifier: string;
  idType?: "cio_id" | "email";
}

/**
 * Identifier ladder for profile lookups — the SINGLE source of truth for
 * which forms work (VOZ-185; consumed by lookupMemberProfileWithFallback
 * here AND the segment-members import route — keep them on this function,
 * a second inline copy is how the forms drifted broken in the first place).
 *
 * Order: workspace `id` (no id_type — prod-proven, untouched) → bare cio_id
 * with `id_type=cio_id` → email with `id_type=email`. The legacy
 * `cio_<cio_id>` prefix and raw-email forms are gone: verified live
 * 2026-07-22 that they 404 on this endpoint, which left the fallback able
 * to rescue nobody past leg 1 (the "Glenda" fix was illusory).
 */
export function lookupLadder(member: CustomerIOSegmentMember): LookupIdentifier[] {
  const ladder: LookupIdentifier[] = [];
  if (typeof member.id === "string" && member.id.trim().length > 0) {
    ladder.push({ identifier: member.id });
  }
  if (typeof member.cio_id === "string" && member.cio_id.trim().length > 0) {
    ladder.push({ identifier: member.cio_id, idType: "cio_id" });
  }
  if (typeof member.email === "string" && member.email.trim().length > 0) {
    ladder.push({ identifier: member.email, idType: "email" });
  }
  return ladder;
}

/**
 * Identifier-fallback profile lookup. Customer.io's segment-membership and
 * customer-profile tables can be inconsistent — a member's workspace `id`
 * exists in the segment but not in /customers. Walk lookupLadder in order;
 * only return failure when ALL identifiers fail. Closes the 2026-05-13
 * "Glenda" silent-drop bug — genuinely, since VOZ-185 fixed the dead
 * cio_id/email rungs.
 */
export async function lookupMemberProfileWithFallback(
  member: CustomerIOSegmentMember,
  workspace?: string | null,
): Promise<CustomerIOResult<CustomerIOCustomer>> {
  const ladder = lookupLadder(member);

  if (ladder.length === 0) {
    return { success: false, data: null, error: "No identifiers available on segment member" };
  }

  let lastError = "All identifiers exhausted";
  for (const rung of ladder) {
    const result = await getCustomerAttributes(rung.identifier, rung.idType, workspace);
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
export async function fetchSegmentPhones(
  segmentId: number,
  workspace?: string | null,
): Promise<
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
    const batchResult = await getSegmentMembers(segmentId, { start: cursor, limit: 1000 }, workspace);
    if (!batchResult.success) {
      return {
        ok: false,
        // NB: "CUSTOMERIO_APP_API_KEYS has no key for workspace …" matches this
        // substring too — missing-config stays a 500 for every workspace.
        status: batchResult.error.includes("CUSTOMERIO_APP_API_KEY") ? 500 : 502,
        error: batchResult.error,
      };
    }

    const profiles = await chunkedPromiseAll(batchResult.data.identifiers, 8, (m) =>
      lookupMemberProfileWithFallback(m, workspace),
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
