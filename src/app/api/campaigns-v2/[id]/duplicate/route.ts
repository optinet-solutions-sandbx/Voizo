import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { createClone } from "@/lib/vapi/cloneAssistant";
import { leaseSlot, linkSlot, patchPhoneAssistant, releaseSlot } from "@/lib/vapi/sipPool";
import {
  getSegmentMembers,
  getCustomerAttributes,
  type CustomerIOSegmentMember,
  type CustomerIOCustomer,
  type CustomerIOResult,
} from "@/lib/customerio";
import { parsePhoneList } from "@/lib/campaignV2Data";

// Up to: paginated customer.io fetch + per-member attribute lookups (~10-30s for
// segments <500 members at the 10 req/sec rate limit), Vapi GET base + POST
// clone (~2-3s), Vapi PATCH slot (~1s), Supabase queries (~1-2s), best-effort
// rollback on failure. 60s gives a generous margin for the typical PoC scale.
export const maxDuration = 60;

const RECENT_CALL_WINDOW_DAYS = 7;

/**
 * campaign_numbers_v2.outcome values that count as "this phone has been
 * meaningfully contacted within the last 7 days." Used by the cross-campaign
 * recent-call diff bucket. Excludes:
 *   - 'pending'        — no contact yet
 *   - 'wrong_number'   — administrative tag, not a contact event
 *   - 'suppressed'     — administrative tag
 *   - 'in_progress'    — counted via the call ending; pending_retry catches mid-call states
 */
const CONTACT_OUTCOMES = [
  "sent_sms",
  "not_interested",
  "declined_offer",
  "unreached",
  "pending_retry",
];

const PHONE_ATTRIBUTE_KEYS = ["phone", "phone_number", "mobile", "mobile_number", "cell", "telephone"];

function extractPhoneFromAttrs(attrs: Record<string, unknown>): string | null {
  for (const key of PHONE_ATTRIBUTE_KEYS) {
    const value = attrs[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * Throttled fan-out to respect customer.io's 10 req/sec per-workspace rate
 * limit. 8 calls per chunk with 150ms pauses keeps worst-case burst safely
 * under cap while completing a 100-member batch in ~10-15s. Same pattern as
 * the existing /api/customerio/segments/[segmentId]/members route — duplicated
 * for now; extract when Step 6 (Manual refresh) lands as the second caller.
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
 * Identifier-fallback profile lookup. Customer.io's segment-membership and
 * customer-profile tables can be inconsistent — a member's workspace id
 * exists in the segment but not in /customers. Try id → cio_<cio_id> → email
 * in order; only return failure when ALL identifiers fail. Closes the
 * 2026-05-13 "Glenda" silent-drop bug; same pattern as the members route.
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
  }
  return { success: false, data: null, error: lastError };
}

/**
 * Paginated fetch of all phones in a customer.io segment.
 *
 * Loops getSegmentMembers with the `next` cursor (1000 per page), fan-outs
 * profile lookups via chunkedPromiseAll, extracts phones via attribute-key
 * variants, normalizes to E.164 via parsePhoneList. Safety cap: 10 pages =
 * 10000 members max. PoC scale is <500 typically.
 */
async function fetchSegmentPhones(segmentId: number): Promise<
  | { ok: true; phones: string[]; sampled: number }
  | { ok: false; status: number; error: string }
> {
  const PAGE_CAP = 10;
  const allRawPhones: string[] = [];
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
      if (phone) allRawPhones.push(phone);
    }

    pages++;
    if (!batchResult.data.next) break;
    cursor = batchResult.data.next;
  }

  // parsePhoneList handles E.164 normalization + dedupe.
  const phones = parsePhoneList(allRawPhones.join("\n"));
  return { ok: true, phones, sampled: allRawPhones.length };
}

// ──────────────────────────────────────────────────────────────────────────

/**
 * POST /api/campaigns-v2/[id]/duplicate
 *
 * Creates a new campaign based on a source campaign, optionally with a fresh
 * customer.io segment fetch and operator-chosen skip strategy over three diff
 * buckets (overlap with source pending / suppressed / recently-called-elsewhere).
 *
 * Two-call protocol:
 *   - First call (commit=false or omitted) returns a preview with diff counts +
 *     5-sample-per-bucket peek. No state changes.
 *   - Second call (commit=true) applies skip choices, creates the new clone,
 *     leases a slot, INSERTs the new campaign row + filtered phone rows.
 *
 * Body:
 *   {
 *     new_name: string,                  // required
 *     refresh_segment?: boolean,         // default true
 *     base_assistant_id?: string,        // override; default = source's
 *     voice_id?: string,                 // override; default = source's
 *     system_prompt?: string,            // override; default = source's
 *     worker_slot?: number | "auto",     // numeric not yet supported (Phase 2)
 *     commit?: boolean,                  // default false (preview)
 *     skip_overlap?: boolean,            // default false
 *     skip_suppressed?: boolean,         // default true
 *     skip_recently_called?: boolean,    // default false
 *   }
 *
 * Restrictions:
 *   - Recurring source campaigns rejected with 400 (recurring auto-spawns
 *     children; duplicating a recurring is a Phase 2 concern).
 *   - refresh_segment=true requires source.segment_id non-null. Multi-segment
 *     imports and pre-Step-5a campaigns have no source segment to refresh
 *     against; 400 with a friendly message instructing the operator to either
 *     refresh_segment=false (copy source's numbers) or run a manual refresh
 *     beforehand.
 *
 * Failure rollback (mirrors the rebind pattern):
 *   - createClone fails              → no state changes, return helper error
 *   - leaseSlot returns null          → DELETE the new clone, 503
 *   - patchPhoneAssistant fails       → releaseSlot + DELETE clone, 502
 *   - INSERT campaign fails           → releaseSlot + DELETE clone, 500
 *   - INSERT campaign_numbers fails   → partial state (campaign row exists
 *                                       with 0 numbers + leased slot). Operator
 *                                       deletes the duplicate to retry; ON
 *                                       DELETE CASCADE reclaims the slot.
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.6
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §5
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Origin check (URL-parsed exact host equality) ──
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  // ── Body parse ──
  type DuplicateBody = {
    new_name?: unknown;
    refresh_segment?: unknown;
    base_assistant_id?: unknown;
    voice_id?: unknown;
    system_prompt?: unknown;
    worker_slot?: unknown;
    commit?: unknown;
    skip_overlap?: unknown;
    skip_suppressed?: unknown;
    skip_recently_called?: unknown;
  };
  let body: DuplicateBody;
  try {
    body = (await request.json()) as DuplicateBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const newName = typeof body.new_name === "string" ? body.new_name.trim() : "";
  if (!newName) {
    return NextResponse.json({ error: "new_name is required" }, { status: 400 });
  }
  if (newName.length > 200) {
    return NextResponse.json({ error: "new_name too long (max 200 chars)" }, { status: 400 });
  }

  const refreshSegment = body.refresh_segment !== false; // default true
  const commit = body.commit === true;
  const skipOverlap = body.skip_overlap === true;
  const skipSuppressed = body.skip_suppressed !== false; // default true
  const skipRecentlyCalled = body.skip_recently_called === true;
  const baseAssistantOverride =
    typeof body.base_assistant_id === "string" ? body.base_assistant_id : undefined;
  const voiceIdOverride = typeof body.voice_id === "string" ? body.voice_id : undefined;
  const systemPromptOverride =
    typeof body.system_prompt === "string" ? body.system_prompt : undefined;
  const requestedWorkerSlot =
    typeof body.worker_slot === "number"
      ? body.worker_slot
      : body.worker_slot === "auto"
      ? "auto"
      : undefined;

  // ── 1. Read source campaign ──
  const { data: source, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select(
      "id, name, system_prompt, base_assistant_id, voice_id, segment_id, " +
      "timezone, call_windows, max_attempts, retry_interval_minutes, " +
      "sms_enabled, sms_template, sms_on_goal_reached_only, " +
      "campaign_type, status",
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
  let candidatePhones: string[];
  let candidateSource: "segment_refresh" | "source_pending";

  if (refreshSegment) {
    if (source.segment_id == null) {
      return NextResponse.json(
        {
          error:
            "Source campaign has no single segment to refresh from " +
            "(multi-segment import or pre-Step-5a campaign). " +
            "Pass refresh_segment=false to copy source's pending numbers as-is.",
        },
        { status: 400 },
      );
    }
    const segmentResult = await fetchSegmentPhones(source.segment_id as number);
    if (!segmentResult.ok) {
      return NextResponse.json(
        { error: `Customer.io fetch failed: ${segmentResult.error}` },
        { status: segmentResult.status },
      );
    }
    candidatePhones = segmentResult.phones;
    candidateSource = "segment_refresh";
  } else {
    // Copy source's pending phones as-is (the "duplicate the untouched batch" use case).
    const { data: sourceNumbers, error: numbersErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .eq("campaign_id", id)
      .in("outcome", ["pending", "pending_retry"]);
    if (numbersErr) {
      return NextResponse.json({ error: "Failed to read source numbers" }, { status: 500 });
    }
    candidatePhones = (sourceNumbers ?? []).map((r) => r.phone_e164 as string);
    candidateSource = "source_pending";
  }

  if (candidatePhones.length === 0) {
    return NextResponse.json(
      { error: `Candidate phone set is empty (${candidateSource}). Nothing to duplicate.` },
      { status: 400 },
    );
  }

  // PostgREST's .in() has a practical limit (~1000 items in the URL). PoC scale
  // is <500 typical; cap here for safety. If a real deployment needs more,
  // paginate the diff queries by phone batches.
  if (candidatePhones.length > 1000) {
    return NextResponse.json(
      {
        error:
          `Candidate set is ${candidatePhones.length} phones; current diff ` +
          `implementation caps at 1000. Reach out to engineering to lift the cap.`,
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

  const sample = (s: Set<string>) => Array.from(s).slice(0, 5);

  // ── 4. Preview only ──
  if (!commit) {
    return NextResponse.json({
      preview: true,
      candidateSource,
      candidatesCount: candidatePhones.length,
      overlap: { count: overlapSet.size, sample: sample(overlapSet) },
      suppressed: { count: suppressedSet.size, sample: sample(suppressedSet) },
      recentlyCalled: { count: recentSet.size, sample: sample(recentSet) },
    });
  }

  // ── 5. Apply skip choices ──
  const finalPhones = candidatePhones.filter((p) => {
    if (skipOverlap && overlapSet.has(p)) return false;
    if (skipSuppressed && suppressedSet.has(p)) return false;
    if (skipRecentlyCalled && recentSet.has(p)) return false;
    return true;
  });

  if (finalPhones.length === 0) {
    return NextResponse.json(
      {
        error:
          "Skip choices filter out all candidate phones. Toggle some flags off " +
          "or pick a different candidate source.",
        committed: false,
      },
      { status: 400 },
    );
  }

  // ── 6. Vapi env ──
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    return NextResponse.json({ error: "VAPI_PRIVATE_KEY is not set" }, { status: 500 });
  }

  // ── 7. Resolve overrides + re-clone ──
  const effectiveBase = baseAssistantOverride ?? (source.base_assistant_id as string | null);
  if (!effectiveBase) {
    return NextResponse.json(
      {
        error:
          "Source campaign has no base_assistant_id and no override was provided. " +
          "Pass base_assistant_id in the body.",
        committed: false,
      },
      { status: 400 },
    );
  }

  const cloneResult = await createClone(vapiKey, effectiveBase, {
    voiceId: voiceIdOverride ?? ((source.voice_id as string | null) ?? undefined),
    systemPrompt: systemPromptOverride ?? (source.system_prompt as string),
    campaignName: newName,
  });

  if (!cloneResult.ok) {
    return NextResponse.json(
      { error: cloneResult.error, committed: false },
      { status: cloneResult.status },
    );
  }
  const clone = cloneResult.clone;

  // ── 8. Lease a slot ──
  const slot = await leaseSlot(supabaseAdmin, clone.id);
  if (!slot) {
    console.warn(`[campaigns-v2/duplicate] SIP pool exhausted; rolling back clone ${clone.id}`);
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiKey}` },
    }).catch(() => {});
    return NextResponse.json(
      {
        error:
          "All SIP pool slots are in use. Eject a running campaign first, or wait for one to complete.",
        committed: false,
      },
      { status: 503 },
    );
  }

  // ── 9. PATCH slot phone to new clone ──
  const patchRes = await patchPhoneAssistant(vapiKey, slot.vapi_phone_number_id, clone.id);
  if (!patchRes.ok) {
    console.error(`[campaigns-v2/duplicate] Vapi PATCH failed:`, patchRes.body.slice(0, 500));
    await releaseSlot(supabaseAdmin, slot.id).catch(() => {});
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiKey}` },
    }).catch(() => {});
    return NextResponse.json(
      { error: `Failed to bind SIP slot: ${patchRes.body.slice(0, 200)}`, committed: false },
      { status: 502 },
    );
  }

  // ── 10. INSERT new campaigns_v2 row ──
  const newCampaignInsert = {
    name: newName,
    vapi_assistant_id: clone.id,
    vapi_assistant_name: clone.name,
    vapi_sip_uri: slot.sip_uri,
    vapi_pool_slot_id: slot.id,
    base_assistant_id: effectiveBase,
    voice_id: voiceIdOverride ?? source.voice_id ?? null,
    segment_id: source.segment_id ?? null,
    system_prompt: systemPromptOverride ?? source.system_prompt,
    timezone: source.timezone,
    call_windows: source.call_windows,
    max_attempts: source.max_attempts,
    retry_interval_minutes: source.retry_interval_minutes,
    sms_enabled: source.sms_enabled,
    sms_template: source.sms_template,
    sms_on_goal_reached_only: source.sms_on_goal_reached_only,
    status: "draft",
    campaign_type: "fixed",
  };

  const { data: newCampaign, error: insertErr } = await supabaseAdmin
    .from("campaigns_v2")
    .insert(newCampaignInsert)
    .select("id")
    .single();

  if (insertErr || !newCampaign) {
    console.error(`[campaigns-v2/duplicate] INSERT campaign failed:`, insertErr);
    await releaseSlot(supabaseAdmin, slot.id).catch(() => {});
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiKey}` },
    }).catch(() => {});
    return NextResponse.json(
      { error: "Failed to create duplicated campaign row", committed: false },
      { status: 500 },
    );
  }

  // ── 11. INSERT filtered campaign_numbers_v2 rows ──
  const numberRows = finalPhones.map((phone) => ({
    campaign_id: newCampaign.id,
    phone_e164: phone,
    outcome: "pending" as const,
  }));

  const { error: numbersErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .insert(numberRows);

  if (numbersErr) {
    console.error(`[campaigns-v2/duplicate] INSERT numbers failed:`, numbersErr);
    // Partial state: campaign row exists with 0 numbers + slot leased to it.
    // The operator can DELETE the duplicate to reclaim the slot (ON DELETE
    // CASCADE drops the row + the existing DELETE handler releases the slot
    // + deletes the clone). Cleaner than us trying to roll back here and
    // potentially leaving a worse state.
    return NextResponse.json(
      {
        error:
          "Campaign row created but failed to insert phone numbers. " +
          "Delete the duplicate to retry.",
        committed: true,
        partial: true,
        newCampaignId: newCampaign.id,
      },
      { status: 500 },
    );
  }

  // ── 12. Back-link slot to campaign ──
  const linked = await linkSlot(supabaseAdmin, {
    slotId: slot.id,
    campaignId: newCampaign.id,
    expectedAssistantId: clone.id,
  });
  if (!linked) {
    console.warn(
      `[campaigns-v2/duplicate] linkSlot returned false for slot ${slot.id} ` +
      `(campaign ${newCampaign.id}, assistant ${clone.id}). Heartbeat will reconcile.`,
    );
  }

  // ── 13. Audit + response ──
  const slotLabel = `voizo-sip-pool-slot-${String(slot.slot_index).padStart(2, "0")}`;
  const skippedCounts = {
    overlap: skipOverlap ? overlapSet.size : 0,
    suppressed: skipSuppressed ? suppressedSet.size : 0,
    recentlyCalled: skipRecentlyCalled ? recentSet.size : 0,
  };

  console.log(
    `[campaigns-v2/duplicate] audit ` +
    JSON.stringify({
      sourceCampaignId: id,
      sourceName: source.name,
      newCampaignId: newCampaign.id,
      newCampaignName: newName,
      newAssistantId: clone.id,
      slotLabel,
      candidateSource,
      candidatesCount: candidatePhones.length,
      skippedCounts,
      dialedCount: finalPhones.length,
      requestedWorkerSlot: requestedWorkerSlot ?? null,
      timestamp: new Date().toISOString(),
    }),
  );

  const warning =
    typeof requestedWorkerSlot === "number"
      ? `targeted worker_slot=${requestedWorkerSlot} requested but targeted lease is not yet supported; used auto (${slotLabel})`
      : undefined;

  return NextResponse.json({
    committed: true,
    sourceCampaignId: id,
    newCampaignId: newCampaign.id,
    newAssistantId: clone.id,
    newAssistantName: clone.name,
    newPoolSlotId: slot.id,
    newSipUri: slot.sip_uri,
    slotLabel,
    candidateSource,
    candidatesCount: candidatePhones.length,
    dialedCount: finalPhones.length,
    skippedCounts,
    ...(warning ? { warning } : {}),
  });
}
