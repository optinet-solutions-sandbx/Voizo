// src/lib/callCost.ts
//
// Per-call cost resolution for the budget guardrail (design 2026-08-04).
// Shared by the Vapi end-of-call webhook and the recording-backfill sweep.
//
// vapiCostUsd:   Vapi's measured `cost` (their bill; excludes OpenAI — BYO org
//                credential, probe 2026-08-04 shows llm=0 on every call).
//                Missing/invalid → NULL so the backfill sweeps it; never 0.
// openaiCostUsd: token-precise when OPENAI_TOKEN_RATES is configured, else
//                duration × the measured $0.032/talk-min blended rate
//                (2026-08-01 basis, same ONE CLOCK as the estimator).
//                0s duration → 0 (never reached the agent). Unknown → NULL.

import { OPENAI_TOKEN_RATES, PRICE_RATES, type OpenAiTokenRates, type PriceRates } from "./costRates";

export interface VapiCostPayload {
  cost?: number | null;
  costBreakdown?: {
    llmPromptTokens?: number | null;
    llmCompletionTokens?: number | null;
    llmCachedPromptTokens?: number | null;
  } | null;
}

export interface ResolvedCallCosts {
  vapiCostUsd: number | null;
  openaiCostUsd: number | null;
}

export function resolveCallCosts(
  payload: VapiCostPayload,
  durationSeconds: number | null,
  prices: PriceRates = PRICE_RATES,
  tokenRates: OpenAiTokenRates | null = OPENAI_TOKEN_RATES,
): ResolvedCallCosts {
  const vapiCostUsd =
    typeof payload.cost === "number" && Number.isFinite(payload.cost) ? payload.cost : null;

  let openaiCostUsd: number | null = null;
  const cb = payload.costBreakdown;
  const prompt = cb?.llmPromptTokens;
  if (
    tokenRates &&
    typeof prompt === "number" &&
    Number.isFinite(prompt)
  ) {
    const completion = numberOr0(cb?.llmCompletionTokens);
    // Clamp: cached can never exceed prompt; a provider glitch must not
    // produce a negative uncached count (and thus a negative dollar figure).
    const cached = Math.min(numberOr0(cb?.llmCachedPromptTokens), prompt);
    openaiCostUsd =
      ((prompt - cached) * tokenRates.inputPerMTok +
        cached * tokenRates.cachedInputPerMTok +
        completion * tokenRates.outputPerMTok) /
      1e6;
  } else if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
    openaiCostUsd = durationSeconds <= 0 ? 0 : (durationSeconds / 60) * prices.openaiPerTalkMin;
  }

  return { vapiCostUsd, openaiCostUsd };
}

function numberOr0(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
