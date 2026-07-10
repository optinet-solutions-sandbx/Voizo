// Server-only data access for Campaign V2. Uses the service-role admin client
// (supabaseAdmin) which bypasses RLS.
//
// ⚠️ NEVER import this from a client component. supabaseServer.ts reads
// SUPABASE_SERVICE_ROLE_KEY (a non-NEXT_PUBLIC env var) and throws at module
// load — so a client import both leaks server intent and breaks the browser
// bundle. Client components must use:
//   - campaignV2Client.ts  (fetch -> /api/campaigns-v2 -> here, service role)
//   - campaignV2Shared.ts  (types + pure helpers, no supabase)
//
// RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md): this module used
// to use the PUBLIC anon client and was imported directly by the browser, which
// is exactly what made the v2 tables readable/writable by anyone holding the
// anon key. Routing every browser read/write through /api routes that call this
// (service role) is the prerequisite for Phase B (dropping the permissive
// `for all using(true)` policies). Types + pure helpers moved to
// campaignV2Shared.ts so client code can keep using them without dragging the
// admin client into the bundle.

import { supabaseAdmin } from "./supabaseServer";
import { normalizeOperatorControls, type CampaignV2CreateInput } from "./campaignV2Shared";

export async function createCampaignV2(input: CampaignV2CreateInput) {
  // Recurring parents save directly as 'running' (active schedule definition);
  // the scheduler scans them by type+status. Fixed campaigns keep the existing
  // draft→running flow gated by start_at + the queue-gate.
  const campaignType = input.campaignType ?? "fixed";
  const status = campaignType === "recurring" ? "running" : "draft";

  const { data: campaign, error: campaignError } = await supabaseAdmin
    .from("campaigns_v2")
    .insert({
      name: input.name,
      vapi_assistant_id: input.vapiAssistantId || null,
      vapi_assistant_name: input.vapiAssistantName || null,
      vapi_sip_uri: input.vapiSipUri || null,
      vapi_pool_slot_id: input.vapiPoolSlotId || null,
      base_assistant_id: input.baseAssistantId || null,
      voice_id: input.voiceId || null,
      segment_id: input.segmentId ?? null,
      system_prompt: input.systemPrompt,
      timezone: input.timezone,
      start_at: input.startAt || null,
      end_at: input.endAt || null,
      call_windows: input.callWindows,
      sms_enabled: input.smsEnabled,
      sms_template: input.smsTemplate || null,
      sms_on_goal_reached_only: input.smsOnGoalReachedOnly ?? true,
      sms_consent_mode: input.smsConsentMode ?? "verbal_yes",
      status,
      campaign_type: campaignType,
      recurrence_pattern: input.recurrencePattern ?? null,
      is_test: input.isTest ?? false,
      created_by: input.createdBy || null,
      source: input.source ?? "production",
      // Optional goal target (X / Y in the performance report). Normalize to a
      // positive integer or null at the write edge so a malformed payload can't
      // reach the DB CHECK (goal_target IS NULL OR goal_target > 0).
      goal_target:
        typeof input.goalTarget === "number" &&
        Number.isInteger(input.goalTarget) &&
        input.goalTarget > 0
          ? input.goalTarget
          : null,
      // Key only sent when the caller explicitly set the flag — an unconditional
      // `voicemail_autohangup: false` would break EVERY campaign create if the
      // code deploys before supabase-migration-voicemail-autohangup.sql is
      // applied. Absent key → DB default false.
      ...(typeof input.voicemailAutohangup === "boolean"
        ? { voicemail_autohangup: input.voicemailAutohangup }
        : {}),
      // Operator controls + realtime mode (VOZ-132): validated/whitelisted by
      // the pure normalizer; conditional keys throughout (see its docblock).
      ...normalizeOperatorControls(input),
    })
    .select()
    .single();

  if (campaignError) throw campaignError;

  // ── Back-link the leased pool slot to this campaign ──
  // The slot was already leased (assistant_id set) by clone-assistant before
  // this function ran. Now that the campaign row exists, set current_campaign_id
  // for operator observability and to satisfy the partial unique index.
  // Both vapiPoolSlotId AND vapiAssistantId are guaranteed for the Fixed flow
  // (the slot was leased to that specific assistant). Recurring parents enter
  // with neither — the && narrows the type and keeps the branch dead for them.
  if (input.vapiPoolSlotId && input.vapiAssistantId) {
    const { linkSlot } = await import("./vapi/sipPool");
    const linked = await linkSlot(supabaseAdmin, {
      slotId: input.vapiPoolSlotId,
      campaignId: campaign.id,
      expectedAssistantId: input.vapiAssistantId,
    });
    if (!linked) {
      // Defensive: if the RPC refused (slot not leased to this assistant),
      // log and continue. Heartbeat reconciliation will surface the orphan.
      console.warn(
        `[createCampaignV2] linkSlot returned false for slot ${input.vapiPoolSlotId} ` +
        `(campaign ${campaign.id}, assistant ${input.vapiAssistantId})`,
      );
    }
  }

  const campaignRows = input.numbers.map((phone) => ({
    campaign_id: campaign.id,
    phone_e164: phone,
    outcome: "pending",
  }));

  if (campaignRows.length > 0) {
    const { error: numbersError } = await supabaseAdmin.from("campaign_numbers_v2").insert(campaignRows);
    if (numbersError) throw numbersError;
  }

  // ── Voicemail auto-hangup: ensure the clone streams transcripts + has controlUrl ──
  // Post-clone PATCH (createClone is untouchable by project rule). Runs AFTER the
  // numbers insert so a stalled Vapi call can never half-create a campaign (row
  // without numbers). Best-effort: ensureVoicemailAutohangupConfig never throws,
  // and a miss is fail-safe — the clone just never triggers kills (Val-lineage
  // clones stream via inheritance anyway). Recurring children are NOT wired yet
  // (trial scope; children default to flag-off — see
  // supabase-migration-voicemail-autohangup.sql).
  if (input.voicemailAutohangup === true && input.vapiAssistantId) {
    const { ensureVoicemailAutohangupConfig } = await import("./vapi/liveCallControl");
    const cfg = await ensureVoicemailAutohangupConfig(
      process.env.VAPI_PRIVATE_KEY ?? "",
      input.vapiAssistantId,
    );
    console.log(
      `[createCampaignV2] voicemail-autohangup config for ${input.vapiAssistantId}: ` +
        `ok=${cfg.ok} patched=${cfg.patched}${cfg.detail ? ` detail=${cfg.detail}` : ""}`,
    );
  }

  return {
    campaign,
    numberCount: campaignRows.length,
  };
}

// --------------- Fetch helpers ---------------

export async function fetchCampaignsV2() {
  // Segregation: internal GhostPortal runs (source='ghost_portal') never appear in
  // the client campaign list or the analytics they feed (campaigns/page.tsx builds
  // both from this). The /s/[slug] ghost view loads its campaign by id via
  // fetchCampaignV2 (singular), so the detail path is unaffected.
  const { data, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .neq("source", "ghost_portal")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function fetchCampaignV2(id: string) {
  const { data, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function updateCampaignV2Status(id: string, status: string) {
  const { data, error } = await supabaseAdmin
    .from("campaigns_v2")
    .update({ status })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
