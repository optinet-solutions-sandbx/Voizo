/**
 * promptVersionData — server-side writer for the prompt_versions table (slice 2).
 *
 * snapshotCampaignPrompt() captures an append-only, immutable record of the EXACT
 * effective system prompt (+ best-effort model/voice meta) a campaign's cloned
 * Vapi assistant ran with. It is the keystone of the eval loop ("did v7 beat v6?").
 *
 * SECURITY: writes go through the service-role client (supabaseAdmin), which
 * bypasses the prompt_versions default-deny RLS. NEVER call this from client code.
 *
 * BEST-EFFORT CONTRACT: this function NEVER throws and NEVER blocks its caller's
 * primary work (campaign launch / rebind / spawn). Every failure path returns a
 * tagged {ok:false, skipped} result AND logs a server-side breadcrumb (a stale
 * keystone table must never be SILENT). The returned shape carries no raw
 * DB/exception text — internals are logged, not returned — so callers / the HTTP
 * route can surface the result safely. A missing snapshot is acceptable; a broken
 * campaign launch is not.
 *
 * Faithfulness: we re-read the clone from Vapi (GET /assistant/{id}) rather than
 * reconstructing the prompt. The clone is immutable after createClone POSTs it, so
 * the re-read returns exactly what ran — not a "cached lie" off the editable base.
 */

import { supabaseAdmin } from "./supabaseServer";
import {
  extractEffectiveSystemPrompt,
  extractModelMeta,
  extractVoiceMeta,
  sha256Hex,
} from "./promptVersionExtract";

/**
 * First line of cloneAssistant.ts's VOIZO_SYSTEM_PREFIX, kept in sync by hand.
 * Defensive observability only (NOT behavior): if a captured effective prompt
 * lacks this marker, the clone may have been posted without the platform prefix
 * or Vapi normalized the system message — we still store it, but warn so phantom
 * "drift" doesn't silently corrupt version comparison. Drift here only ever costs
 * a spurious log line. Source of truth: src/lib/vapi/cloneAssistant.ts (VOIZO_SYSTEM_PREFIX).
 */
const VOIZO_PREFIX_SENTINEL = "[System Instructions — Voizo Platform]";

export type SnapshotSkipReason =
  | "no-assistant-id"
  | "no-vapi-key"
  | "vapi-fetch-failed"
  | "no-system-prompt"
  | "db-error"
  | "exception";

export type SnapshotResult =
  | { ok: true; versionId: string | null; deduped: boolean }
  | { ok: false; skipped: SnapshotSkipReason };

/** Server-side breadcrumb for a skipped best-effort snapshot. `detail` is logged, never returned. */
function warnSkip(campaignId: string, skipped: SnapshotSkipReason, detail?: string): void {
  console.warn(
    `[promptVersion] snapshot skipped for campaign ${campaignId}: ${skipped}` +
      (detail ? ` — ${detail}` : ""),
  );
}

/**
 * Snapshot the effective prompt for a campaign's clone into prompt_versions.
 *
 * @param campaignId      campaigns_v2.id this version is attributed to.
 * @param assistantIdHint when the caller already holds the clone id (rebind /
 *                        spawn), pass it to skip the campaigns_v2 lookup. The
 *                        HTTP route (manual create) omits it and we read the row.
 */
export async function snapshotCampaignPrompt(
  campaignId: string,
  assistantIdHint?: string,
): Promise<SnapshotResult> {
  try {
    // ── 1. Resolve the clone's assistant id ──
    let assistantId = assistantIdHint ?? null;
    if (!assistantId) {
      const { data, error } = await supabaseAdmin
        .from("campaigns_v2")
        .select("vapi_assistant_id")
        .eq("id", campaignId)
        .single();
      if (error) {
        warnSkip(campaignId, "db-error", error.message);
        return { ok: false, skipped: "db-error" };
      }
      assistantId = (data?.vapi_assistant_id as string | null) ?? null;
    }
    if (!assistantId) {
      warnSkip(campaignId, "no-assistant-id");
      return { ok: false, skipped: "no-assistant-id" };
    }

    // ── 2. Vapi key (server-only) ──
    const vapiKey = process.env.VAPI_PRIVATE_KEY;
    if (!vapiKey) {
      warnSkip(campaignId, "no-vapi-key");
      return { ok: false, skipped: "no-vapi-key" };
    }

    // ── 3. Re-read the immutable clone (the faithful record of what ran) ──
    // Bounded timeout: server hooks AWAIT this on the rebind/resume response path
    // (Vercel kills post-response work, so we can't fire-and-forget). An unbounded
    // GET against a slow/degraded Vapi could push the host past maxDuration and
    // surface a SUCCESSFUL rebind as a 504 to the operator. AbortSignal caps it;
    // the AbortError is caught by the outer try/catch → tagged skip (never throws).
    const res = await fetch(
      `https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`,
      {
        headers: { Authorization: `Bearer ${vapiKey}`, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      warnSkip(campaignId, "vapi-fetch-failed", `HTTP ${res.status}`);
      return { ok: false, skipped: "vapi-fetch-failed" };
    }
    const assistant = await res.json();

    // ── 4. Extract effective prompt + best-effort meta ──
    const systemPrompt = extractEffectiveSystemPrompt(assistant);
    if (!systemPrompt) {
      warnSkip(campaignId, "no-system-prompt");
      return { ok: false, skipped: "no-system-prompt" };
    }
    // Defensive: the prompt SHOULD always carry the Voizo platform prefix. If it
    // doesn't, store it anyway (best-effort) but flag it — a silent prefix-less
    // snapshot would read as phantom drift against prior prefixed versions.
    if (!systemPrompt.includes(VOIZO_PREFIX_SENTINEL)) {
      console.warn(
        `[promptVersion] captured prompt for campaign ${campaignId} (assistant ${assistantId}) ` +
          `is missing the Voizo platform prefix — storing anyway, but check for a Vapi-side ` +
          `normalization regression.`,
      );
    }
    const promptSha256 = sha256Hex(systemPrompt);
    const modelMeta = extractModelMeta(assistant);
    const voiceMeta = extractVoiceMeta(assistant);

    // ── 5. Idempotent, append-only insert (unique on campaign_id, prompt_sha256) ──
    // ignoreDuplicates => a rebind/resume that changed nothing is a silent no-op;
    // a real prompt change (new sha) inserts a new version row.
    const { data, error } = await supabaseAdmin
      .from("prompt_versions")
      .upsert(
        {
          campaign_id: campaignId,
          assistant_id: assistantId,
          system_prompt: systemPrompt,
          prompt_sha256: promptSha256,
          model_meta: modelMeta,
          voice_meta: voiceMeta,
        },
        { onConflict: "campaign_id,prompt_sha256", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();
    if (error) {
      warnSkip(campaignId, "db-error", error.message);
      return { ok: false, skipped: "db-error" };
    }

    // No row back => the (campaign_id, sha) already existed (dedupe), which is success.
    return { ok: true, versionId: (data?.id as string | undefined) ?? null, deduped: !data };
  } catch (err) {
    warnSkip(campaignId, "exception", err instanceof Error ? err.message : String(err));
    return { ok: false, skipped: "exception" };
  }
}
