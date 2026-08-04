// src/lib/costRates.ts
//
// PRICE side of the campaign cost estimator (spec 2026-08-04 §4).
// Behavior rates come from /api/campaigns-v2/estimate-rates; these are the
// $-per-talk-minute constants. THE ONE CLOCK: a "talk minute" is a minute of
// calls_v2.duration_seconds (FS billsec) — any re-measured rate MUST use it.

/** duration_seconds is billsec (talk-only) from this date (VOZ-247, 2e2145b). */
export const BILLSEC_EPOCH = "2026-07-28";

export interface PriceRates {
  /** $ per talk-minute, Vapi platform. */
  vapiPerTalkMin: number;
  /** $ per talk-minute, OpenAI tokens — BLENDED (incl. voicemail talk). */
  openaiPerTalkMin: number;
  /** false = placeholder pending invoice confirmation; card shows amber badge. */
  verified: { vapi: boolean; openai: boolean };
  /** Human-readable basis, rendered in the audit panel. */
  basis: string;
}

export const PRICE_RATES: PriceRates = {
  // TO-VERIFY: Vapi public list price ($0.05/min platform) — NOT confirmed
  // against our invoice. Flip verified.vapi=true when Jas/Chris confirm.
  vapiPerTalkMin: 0.05,
  // Measured 2026-08-01: day's OpenAI spend ÷ 777.4 duration-minutes (blended,
  // incl. voicemail talk — the agent speaks into voicemail until isVoicemail
  // cuts). Numerator is secondhand → verified:false until billing-confirmed.
  openaiPerTalkMin: 0.032,
  verified: { vapi: false, openai: false },
  basis:
    "per duration_seconds-minute (FS billsec), blended incl. voicemail; " +
    "OpenAI rate measured on 2026-08-01 traffic mix",
};
