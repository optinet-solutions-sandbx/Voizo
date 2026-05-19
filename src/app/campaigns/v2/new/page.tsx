// src/app/campaigns/v2/new/page.tsx
//
// Wizard-port route shell — Slice 7 flipped the default.
//
//   - Default `/campaigns/v2/new`            → 5-step wizard
//   - `/campaigns/v2/new?classic=1`          → original 1100-line form (1-week escape hatch)
//   - Slice 8 (deferred, post-demo + 1-week observation) deletes classic
//
// All form state lives in the typed reducer at `./wizardState.ts`. Step
// components receive `state` + `dispatch` via props — no Context.
//
// See plan: C:\Users\jasin\.claude\plans\new-shift-picking-gentle-puffin.md

"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { createCampaignV2 } from "@/lib/campaignV2Data";

import { ClassicNewCampaignPage } from "./page-classic";
import {
  buildCloneRequest, buildCreateInput, createInitialState, validateBeforeSubmit,
  wizardReducer, type CloneResult, type Step,
} from "./wizardState";
import Stepper from "./components/Stepper";
import FooterNav from "./components/FooterNav";
import PreviewRail from "./components/PreviewRail";
import StepAudience from "./components/StepAudience";
import StepAgent, { type Assistant } from "./components/StepAgent";
import StepSchedule from "./components/StepSchedule";
import StepFollowup from "./components/StepFollowup";
import StepReview from "./components/StepReview";

export default function NewCampaignRoute() {
  const search = useSearchParams();
  // Slice 7: wizard is the default. `?classic=1` reverses to the original
  // 1100-line form as a 1-week observation escape hatch. Slice 8 deletes
  // the classic copy.
  if (search?.get("classic") === "1") {
    return <ClassicNewCampaignPage />;
  }
  return <WizardPage />;
}

function WizardPage() {
  const router = useRouter();
  const [state, dispatch] = useReducer(wizardReducer, undefined, createInitialState);

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
          const body = await res.json().catch(() => ({}));
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
        const errBody = await cloneRes.json().catch(() => ({}));
        throw new Error(errBody.error || `Clone failed (${cloneRes.status})`);
      }
      const clone = (await cloneRes.json()) as CloneResult;

      const { campaign } = await createCampaignV2(buildCreateInput(state, clone));
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

  // Continue/Launch button disable: on any step, refuse to advance if the
  // current step has visible invalid fields. The final step's button
  // becomes Launch; same validator runs there too.
  const nextDisabled =
    state.saving ||
    (state.step === 5 && validateBeforeSubmit(state) !== null);

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

          {state.step === 1 && <StepAudience state={state} dispatch={dispatch} />}
          {state.step === 2 && (
            <StepAgent
              state={state}
              dispatch={dispatch}
              assistants={assistants}
              assistantsError={assistantsError}
            />
          )}
          {state.step === 3 && <StepSchedule state={state} dispatch={dispatch} />}
          {state.step === 4 && <StepFollowup state={state} dispatch={dispatch} />}
          {state.step === 5 && <StepReview state={state} dispatch={dispatch} />}

          <FooterNav
            currentStep={state.step}
            onBack={() => dispatch({ type: "BACK" })}
            onNext={() => dispatch({ type: "NEXT" })}
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
