// src/app/campaigns/v2/new/page.tsx
//
// Wizard-port route shell.
//
//   - `/campaigns/v2/new`  → 5-step wizard (the only creation path)
//   - `?classic=1` retired 2026-06-04 (page-classic.tsx deleted) — it bypassed
//     the wizard's creation guards and mapped "Immediately" → start_at=null;
//     the param now falls through to the guarded wizard.
//
// All form state lives in the typed reducer at `./wizardState.ts`. Step
// components receive `state` + `dispatch` via props — no Context.
//
// See plan: C:\Users\jasin\.claude\plans\new-shift-picking-gentle-puffin.md

"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useReducer, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { createCampaignV2 } from "@/lib/campaignV2Client";
import { parsePhoneList } from "@/lib/campaignV2Shared";
import { analyzeAudienceCountry, countryLabel } from "@/lib/audienceCountry";
import { consumeDuplicatePrefillCache } from "@/lib/duplicatePrefillCache";
import { parseJsonBody } from "@/lib/jsonBody";

import {
  buildCloneRequest, buildCreateInput, createInitialState, decomposeSmsTemplate,
  deriveScheduleRows, validateBeforeSubmit, wizardReducer,
  type CloneResult, type Step,
} from "./wizardState";
import Stepper from "./components/Stepper";
import FooterNav from "./components/FooterNav";
import PreviewRail from "./components/PreviewRail";
import StepAudience from "./components/StepAudience";
import StepAgent, { type Assistant, type ScriptOption } from "./components/StepAgent";
import StepSchedule from "./components/StepSchedule";
import StepFollowup from "./components/StepFollowup";
import StepReview from "./components/StepReview";

/**
 * Route entrypoint. `useSearchParams()` in Next.js 16 requires a Suspense
 * boundary at prerender time — the build fails statically with
 * "useSearchParams() should be wrapped in a suspense boundary" otherwise.
 * Wrap the searchParams-using component in <Suspense>; the fallback is a
 * minimal spinner since the branch decision is sub-second on the client.
 */
export default function NewCampaignPage() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <NewCampaignRoute />
    </Suspense>
  );
}

function NewCampaignRoute() {
  const search = useSearchParams();
  // Audience-tab prefill (Slice 4): ?source=local_segment&id=<uuid> hands a
  // recycled audience to the wizard. WizardPage fetches the segment server-
  // side on mount and prefills numbersText + audienceSource + name.
  const source = search?.get("source") ?? null;
  const id = search?.get("id") ?? null;
  if (source === "local_segment" && id) {
    return <WizardPage prefillSegmentId={id} />;
  }
  // Duplicate-via-Wizard (2026-05-21): ?source=campaign&id=<uuid>&skip=<csv>
  // &name=<string>&refresh_segment=<bool>. The detail-page Duplicate modal sets
  // these params after the operator picks the skip strategy.
  if (source === "campaign" && id) {
    return (
      <WizardPage
        prefillCampaignId={id}
        prefillCampaignSkip={search?.get("skip") ?? "overlap,suppressed"}
        prefillCampaignName={search?.get("name") ?? undefined}
        prefillCampaignRefreshSegment={search?.get("refresh_segment") !== "false"}
      />
    );
  }
  return <WizardPage />;
}

function RouteFallback() {
  return (
    <div className="h-full grid place-items-center text-[var(--text-3)]">
      <div className="inline-flex items-center gap-2 text-sm">
        <Loader2 size={16} className="animate-spin" />
        Loading…
      </div>
    </div>
  );
}

interface DuplicateSkipped {
  total: number;
  shown: number;
  appliedSkips: string[];
}

function WizardPage({
  prefillSegmentId,
  prefillCampaignId,
  prefillCampaignSkip,
  prefillCampaignName,
  prefillCampaignRefreshSegment,
}: {
  prefillSegmentId?: string;
  prefillCampaignId?: string;
  prefillCampaignSkip?: string;
  prefillCampaignName?: string;
  prefillCampaignRefreshSegment?: boolean;
}) {
  const router = useRouter();
  const [state, dispatch] = useReducer(wizardReducer, undefined, createInitialState);

  // Tracked separately from WizardState so the StepAudience footnote can show
  // the operator-chosen skip stats without polluting the campaign create payload.
  const [duplicateSkipped, setDuplicateSkipped] = useState<DuplicateSkipped | null>(null);

  // M1: notice when the source's SMS template contained 2+ URLs. The wizard's
  // SMS-link field only tracks the trailing URL; the others stay embedded in
  // the Message field. Operators sometimes delete the embedded ones thinking
  // they're cruft — this banner warns them not to.
  const [smsMultiUrlNotice, setSmsMultiUrlNotice] = useState<{
    urlCount: number;
    trackedLink: string;
  } | null>(null);

  // Slice 4 (Audience tab): if the URL carries ?source=local_segment&id=<uuid>,
  // fetch the segment server-side and prefill the wizard's audience fields.
  // Paginates to handle segments larger than the API's per-page cap (500).
  // No new wizard state — just dispatches SET_AUDIENCE_FIELDS once on mount.
  useEffect(() => {
    if (!prefillSegmentId) return;
    let cancelled = false;
    (async () => {
      try {
        const phones: string[] = [];
        let cursor: string | null = null;
        let segmentName: string | null = null;
        // Safety: cap at 20 pages × 500 = 10000 phones (segment API caps
        // candidates at 5000, so 20 pages is generous defense in depth).
        for (let i = 0; i < 20; i++) {
          const qs = new URLSearchParams({ limit: "500" });
          if (cursor) qs.set("cursor", cursor);
          const r = await fetch(`/api/audience/segments/${prefillSegmentId}?${qs}`, {
            cache: "no-store",
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const body = (await r.json()) as {
            segment: { name: string } | null;
            numbers: Array<{ phone_e164: string }>;
            pagination: { nextCursor: string | null; hasMore: boolean };
          };
          if (i === 0 && body.segment) segmentName = body.segment.name;
          for (const n of body.numbers ?? []) phones.push(n.phone_e164);
          if (!body.pagination?.hasMore || !body.pagination?.nextCursor) break;
          cursor = body.pagination.nextCursor;
        }
        if (cancelled) return;
        const label = segmentName ? `Recycled · ${segmentName}` : "Recycled · audience";
        dispatch({
          type: "SET_AUDIENCE_FIELDS",
          payload: {
            name: label,
            numbersText: phones.join("\n"),
            // 2026-05-22: Audience-tab entry → Voizo source tab pre-selected.
            // voizoSegmentId/Name lets StepAudience render the "Selected: X"
            // indicator instead of the old "Recycled ·" banner in manual mode.
            audienceSource: "voizo",
            voizoSegmentId: prefillSegmentId,
            voizoSegmentName: segmentName ?? null,
            voizoPhones: phones.join("\n"),
            segmentId: null,
            segmentName: label,
          },
        });
      } catch (err) {
        console.warn("[wizard] prefill from local segment failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [prefillSegmentId]);

  // Duplicate-via-Wizard (2026-05-21): if the URL carries ?source=campaign,
  // the detail-page modal already showed the operator the diff + skip choices.
  // We re-fetch the same payload here (with the operator's skip CSV) so the
  // wizard can dispatch SET_AUDIENCE_FIELDS / SET_AGENT_FIELDS / SET_SCHEDULE_FIELDS
  // / SET_SMS_FIELDS in one mount-time pass. No new WizardState fields — the
  // skipped counts live in local state for the StepAudience footnote only.
  //
  // M8 (2026-05-22): the modal's fetch result is cached in duplicatePrefillCache
  // module-level state. If present + fresh, we consume it here and skip the
  // network call entirely — saves the second CIO fetch (10-30s) per duplicate.
  useEffect(() => {
    if (!prefillCampaignId) return;
    let cancelled = false;
    (async () => {
      try {
        const refreshSeg = prefillCampaignRefreshSegment ?? true;
        const skipCsv = prefillCampaignSkip ?? "overlap,suppressed";

        type DuplicateBody = {
          source: {
            name: string;
            base_assistant_id: string | null;
            voice_id: string | null;
            system_prompt: string | null;
            timezone: string;
            call_windows: Array<{ day: string; start: string; end: string }> | null;
            sms_enabled: boolean | null;
            sms_template: string | null;
            sms_consent_mode?: string | null;
            segment_id: number | null;
          };
          prefill: {
            suggestedName: string;
            phones: string[];
            appliedSkips: string[];
            candidates: string[];
            overlap: string[];
            suppressed: string[];
            recentlyCalled: string[];
          };
        };

        let body: DuplicateBody | null = consumeDuplicatePrefillCache(
          prefillCampaignId,
          refreshSeg,
        ) as DuplicateBody | null;

        if (body) {
          // Cache hit — the modal already paid the CIO fetch cost. The cached
          // prefill.phones was server-filtered with the modal's skip (default
          // overlap+suppressed); re-apply the operator's actual skipCsv here
          // on the raw candidate + bucket arrays. Same algorithm as the
          // server's section "Apply skip strategy based on query params".
          const skipFlags = new Set(
            skipCsv.split(",").map((s) => s.trim()).filter(Boolean),
          );
          const overlap = new Set(body.prefill.overlap ?? []);
          const suppressed = new Set(body.prefill.suppressed ?? []);
          const recent = new Set(body.prefill.recentlyCalled ?? []);
          const candidates = body.prefill.candidates ?? [];
          const filteredPhones = candidates.filter((p) => {
            if (skipFlags.has("overlap") && overlap.has(p)) return false;
            if (skipFlags.has("suppressed") && suppressed.has(p)) return false;
            if (skipFlags.has("recent") && recent.has(p)) return false;
            return true;
          });
          body = {
            ...body,
            prefill: {
              ...body.prefill,
              phones: filteredPhones,
              appliedSkips: Array.from(skipFlags),
            },
          };
        } else {
          // Cache miss — fetch (slow path, mirrors the modal's original call).
          const qs = new URLSearchParams({
            refresh_segment: String(refreshSeg),
            skip: skipCsv,
          });
          const r = await fetch(`/api/campaigns-v2/${prefillCampaignId}/duplicate?${qs}`, {
            cache: "no-store",
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          body = (await r.json()) as DuplicateBody;
        }

        if (cancelled) return;
        const src = body.source;
        const pf = body.prefill;

        setDuplicateSkipped({
          total: pf.candidates.length,
          shown: pf.phones.length,
          appliedSkips: pf.appliedSkips ?? [],
        });

        // Operator's chosen name (from modal) takes precedence over the
        // server's suggestedName. Fall back if missing.
        const name = (prefillCampaignName?.trim() || pf.suggestedName || `${src.name} (duplicate)`);
        const label = `Duplicated from ${src.name}`;
        dispatch({
          type: "SET_AUDIENCE_FIELDS",
          payload: {
            name,
            timezone: src.timezone,
            numbersText: (pf.phones ?? []).join("\n"),
            // 2026-05-22: duplicate ships a frozen phone list, not a live
            // segment link — operator lands on the Paste manually tab with
            // the phones populated. manualPhones cache mirrors numbersText
            // so the Paste tab keeps its selection across tab flips.
            audienceSource: "manual",
            manualPhones: (pf.phones ?? []).join("\n"),
            // Pin to null — duplicate campaigns are NOT bound to a Customer.io
            // segment_id (refresh on the wizard's submit would re-fetch and
            // potentially diverge from the operator's chosen-filtered list).
            segmentId: null,
            segmentName: label,
          },
        });

        if (src.base_assistant_id) {
          dispatch({
            type: "SET_AGENT_FIELDS",
            payload: {
              vapiAssistantId: src.base_assistant_id,
              baseVoiceId: src.voice_id ?? null,
              systemPrompt: src.system_prompt ?? "",
            },
          });
        }

        dispatch({
          type: "SET_SCHEDULE_FIELDS",
          payload: {
            campaignType: "fixed",
            scheduleRows: deriveScheduleRows(src.call_windows, src.timezone),
            startMode: "now",
          },
        });

        const sms = decomposeSmsTemplate(src.sms_template);
        // M1: count URLs in the source template. decomposeSmsTemplate only
        // extracts the trailing one; others stay in sms.message. Surface
        // a banner so the operator doesn't delete the embedded URLs by
        // mistake when editing the Message field.
        const urlMatches = (src.sms_template ?? "").match(/https?:\/\/\S+/g) ?? [];
        if (urlMatches.length > 1) {
          setSmsMultiUrlNotice({ urlCount: urlMatches.length, trackedLink: sms.link });
        }
        dispatch({
          type: "SET_SMS_FIELDS",
          payload: {
            smsEnabled: !!src.sms_enabled,
            smsConsentMode: src.sms_consent_mode === "registered_optin" ? "registered_optin" : "verbal_yes",
            smsMessage: sms.message,
            smsLink: sms.link,
            smsOptout: sms.optout,
          },
        });
      } catch (err) {
        if (cancelled) return;
        console.warn("[wizard] prefill from campaign duplicate failed:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [prefillCampaignId, prefillCampaignSkip, prefillCampaignName, prefillCampaignRefreshSegment]);

  // Assistants list — fetched once on WizardPage mount so navigating
  // between steps doesn't refetch. Mirrors classic page-classic.tsx:259-276.
  // Kept as local state (not WizardState) because it's fetched data,
  // not form input.
  const [assistants, setAssistants] = useState<Assistant[] | null>(null);
  const [assistantsError, setAssistantsError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/vapi/assistants");
        if (!res.ok) {
          const body = await parseJsonBody(res);
          setAssistantsError(body.error || `Failed to load assistants (${res.status})`);
          setAssistants([]);
          return;
        }
        const body = await res.json();
        setAssistants(body.assistants ?? []);
      } catch (err) {
        setAssistantsError(err instanceof Error ? err.message : "Network error");
        setAssistants([]);
      }
    })();
  }, []);

  // Scripts list (VOZ-159) — same once-on-mount pattern as assistants, for the
  // Step-2 Script-mode dropdown.
  const [scripts, setScripts] = useState<ScriptOption[] | null>(null);
  const [scriptsError, setScriptsError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/scripts");
        if (!res.ok) {
          const body = await parseJsonBody(res);
          setScriptsError(body.error || `Failed to load scripts (${res.status})`);
          setScripts([]);
          return;
        }
        const body = await res.json();
        setScripts(body.scripts ?? []);
      } catch (err) {
        setScriptsError(err instanceof Error ? err.message : "Network error");
        setScripts([]);
      }
    })();
  }, []);

  /**
   * Submit — porting classic page-classic.tsx::handleSubmit (310-440)
   * verbatim through `buildCloneRequest` + `buildCreateInput` helpers, so
   * the payload sent to /api/vapi/clone-assistant and createCampaignV2()
   * matches the classic byte-for-byte. R1 gate: payload diff in DevTools
   * Network tab before Slice 7 merge.
   */
  const handleLaunch = useCallback(async () => {
    const validationError = validateBeforeSubmit(state);
    if (validationError) {
      dispatch({ type: "SUBMIT_ERROR", error: validationError });
      return;
    }

    dispatch({ type: "SUBMIT_START" });
    try {
      if (state.campaignType === "recurring") {
        // Recurring: no clone, single createCampaignV2 call.
        const { campaign } = await createCampaignV2(buildCreateInput(state));
        router.push(`/campaigns/v2/${campaign.id}`);
        return;
      }

      // Fixed: clone the Vapi assistant first, then createCampaignV2 using
      // the clone response.
      const cloneRes = await fetch("/api/vapi/clone-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCloneRequest(state)),
      });
      if (!cloneRes.ok) {
        const errBody = await parseJsonBody(cloneRes);
        throw new Error(errBody.error || `Clone failed (${cloneRes.status})`);
      }
      const clone = (await cloneRes.json()) as CloneResult;

      const { campaign } = await createCampaignV2(buildCreateInput(state, clone));

      // Best-effort prompt-version snapshot (slice 2 — eval-loop keystone).
      // Fire-and-forget: a snapshot must NEVER block or fail the launch. It stays
      // a separate route because it re-reads the clone from Vapi and writes the
      // default-deny prompt_versions table via the service role — a distinct
      // concern from campaign creation. keepalive:true lets the request survive
      // the router.push navigation below (a soft-nav can otherwise abort an
      // in-flight fetch); the server warn-logs any skip.
      void fetch(`/api/campaigns-v2/${campaign.id}/snapshot-prompt`, {
        method: "POST",
        keepalive: true,
      }).catch(() => {});

      router.push(`/campaigns/v2/${campaign.id}`);
    } catch (err) {
      console.error("Failed to create Campaign V2 via wizard:", err);
      dispatch({
        type: "SUBMIT_ERROR",
        error:
          err instanceof Error
            ? err.message
            : "Failed to save the campaign. Please check the fields and try again.",
      });
    }
  }, [state, router]);

  // M2: when no single country dominates but the audience clearly spans
  // multiple, surface the breakdown so the operator picks tz with full info.
  // (The country/tz mismatch is now a hard submit-time block + keyed override
  // checkbox in StepAudience — no Next-click confirm here.)
  const step1Phones = state.step === 1 ? parsePhoneList(state.numbersText) : [];
  const step1MixedAnalysis = state.step === 1 ? analyzeAudienceCountry(step1Phones) : null;
  const step1IsMixed = !!step1MixedAnalysis?.isMixed;

  // Continue/Launch button disable: only true blockers (mid-submit or final-
  // step validation). The country/tz mismatch is a hard block inside
  // validateBeforeSubmit (with a keyed override checkbox in Step 1).
  const nextDisabled =
    state.saving ||
    (state.step === 5 && validateBeforeSubmit(state) !== null);

  // TZ-mismatch is now a hard submit-time block (validateBeforeSubmit) with a
  // keyed override checkbox in Step 1 — no Next-click confirm needed.
  const handleNext = useCallback(() => {
    dispatch({ type: "NEXT" });
  }, [dispatch]);

  return (
    <div className="h-full grid grid-cols-[240px_1fr_340px] max-[1280px]:grid-cols-[200px_1fr_300px] overflow-hidden">
      <Stepper
        currentStep={state.step}
        onJump={(s: Step) => dispatch({ type: "GOTO_STEP", step: s })}
      />

      <main className="overflow-y-auto px-9 py-7 min-w-0">
        <div className="max-w-[720px] w-full mx-auto h-full flex flex-col">
          <nav className="flex items-center gap-1.5 text-xs text-[var(--text-3)] mb-2">
            <Link href="/campaigns" className="text-[var(--text-3)] hover:text-blue-400 transition-colors">
              Campaigns
            </Link>
            <span className="opacity-50">›</span>
            <span>New</span>
          </nav>

          <div className="glow-card flex-1 flex flex-col rounded-2xl p-6 sm:p-7">
          {state.step === 1 && step1IsMixed && step1MixedAnalysis && (
            // M2: mixed-country audience advisory. Surfaces when no single
            // country reaches the 80% confidence threshold AND ≥2 countries
            // have meaningful share. Informational — operator still proceeds
            // with whatever timezone they choose.
            <div className="mb-3 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-300">
              <p className="font-medium">Mixed-country audience detected</p>
              <p className="mt-1 text-[13px] text-amber-200/80">
                {step1MixedAnalysis.byCountry
                  .filter((b) => b.share >= 0.05)
                  .map((b) => `${countryLabel(b.country) || b.country} ${Math.round(b.share * 100)}%`)
                  .join(" · ")}
                {". Pick the timezone that matches the majority. Voizo dials in one timezone per campaign; others may get calls at unusual hours."}
              </p>
            </div>
          )}
          {state.step === 1 && (
            <StepAudience state={state} dispatch={dispatch} duplicateSkipped={duplicateSkipped} />
          )}
          {state.step === 2 && (
            <StepAgent
              state={state}
              dispatch={dispatch}
              assistants={assistants}
              assistantsError={assistantsError}
              scripts={scripts}
              scriptsError={scriptsError}
            />
          )}
          {state.step === 3 && <StepSchedule state={state} dispatch={dispatch} />}
          {state.step === 4 && smsMultiUrlNotice && (
            // M1: multi-URL SMS template notice. decomposeSmsTemplate only
            // extracts the trailing URL — the others stay embedded in the
            // Message field. Tell the operator so they don't strip the
            // embedded ones thinking they're cruft.
            <div className="mb-3 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-sm text-amber-300">
              <p className="font-medium">Multi-URL template detected</p>
              <p className="mt-1 text-[13px] text-amber-200/80">
                The source template contained {smsMultiUrlNotice.urlCount} URLs. The
                Link field tracks the trailing one (
                <span className="font-mono text-[12px]">{smsMultiUrlNotice.trackedLink || "—"}</span>
                ). Any earlier URLs stay embedded in the Message field. Don&apos;t
                remove them unless intentional.
              </p>
            </div>
          )}
          {state.step === 4 && <StepFollowup state={state} dispatch={dispatch} />}
          {state.step === 5 && <StepReview state={state} dispatch={dispatch} />}
          </div>

          <FooterNav
            currentStep={state.step}
            onBack={() => dispatch({ type: "BACK" })}
            onNext={handleNext}
            onLaunch={handleLaunch}
            nextDisabled={nextDisabled}
            saving={state.saving}
          />
        </div>
      </main>

      <PreviewRail state={state} />
    </div>
  );
}
