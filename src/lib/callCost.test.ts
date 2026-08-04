import { describe, expect, it } from "vitest";
import { resolveCallCosts } from "./callCost";
import type { OpenAiTokenRates, PriceRates } from "./costRates";

const prices: PriceRates = {
  vapiPerTalkMin: 0.05,
  openaiPerTalkMin: 0.032,
  verified: { vapi: false, openai: false },
  basis: "test",
};
const tokenRates: OpenAiTokenRates = {
  inputPerMTok: 1.25,
  cachedInputPerMTok: 0.125,
  outputPerMTok: 10,
};

describe("resolveCallCosts — per-call cost ingestion (budget guardrail)", () => {
  it("passes Vapi's measured cost through verbatim", () => {
    const r = resolveCallCosts({ cost: 0.0427 }, 34, prices, null);
    expect(r.vapiCostUsd).toBe(0.0427);
  });
  it("missing/invalid Vapi cost → null (backfill will sweep it), never 0", () => {
    expect(resolveCallCosts({}, 34, prices, null).vapiCostUsd).toBeNull();
    expect(resolveCallCosts({ cost: Number.NaN }, 34, prices, null).vapiCostUsd).toBeNull();
  });
  it("token rates configured: OpenAI = (prompt−cached)×in + cached×cachedIn + completion×out, per MTok", () => {
    // real 08-04 shape: 11214 prompt (10496 cached) + 75 completion
    const r = resolveCallCosts(
      { cost: 0.0427, costBreakdown: { llmPromptTokens: 11214, llmCachedPromptTokens: 10496, llmCompletionTokens: 75 } },
      34, prices, tokenRates,
    );
    const expected = ((11214 - 10496) * 1.25 + 10496 * 0.125 + 75 * 10) / 1e6;
    expect(r.openaiCostUsd).toBeCloseTo(expected, 10);
  });
  it("no token rates: falls back to duration × measured $/talk-min", () => {
    const r = resolveCallCosts({ cost: 0.0427 }, 60, prices, null);
    expect(r.openaiCostUsd).toBeCloseTo(0.032, 10);
  });
  it("zero-duration call: OpenAI cost is 0 (never reached the agent)", () => {
    expect(resolveCallCosts({ cost: 0.001 }, 0, prices, null).openaiCostUsd).toBe(0);
  });
  it("unknown duration and no tokens: OpenAI cost null, never invented", () => {
    expect(resolveCallCosts({ cost: 0.001 }, null, prices, null).openaiCostUsd).toBeNull();
  });
  it("cached tokens exceeding prompt tokens are clamped (defensive)", () => {
    const r = resolveCallCosts(
      { costBreakdown: { llmPromptTokens: 100, llmCachedPromptTokens: 150, llmCompletionTokens: 0 } },
      10, prices, tokenRates,
    );
    expect(r.openaiCostUsd).toBeGreaterThanOrEqual(0);
  });
});
