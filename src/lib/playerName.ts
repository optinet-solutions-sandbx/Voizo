// Speech-boundary hygiene for imported player names (greet-by-name, 2026-07-17).
//
// campaign_numbers_v2.display_name stores the RAW name as Customer.io gave it
// ("kassandra sergerie lefrancois") — honest data for dashboards/exports. This
// helper runs only where a name is about to be SPOKEN or greeting-formatted:
// take the FIRST token, validate hard, Title-Case it. Anything suspect → null,
// and callers fall back to the nameless greeting — a missing name must never
// degrade or block a call.
//
// \p{L} (any Unicode letter) rather than A-Z: CA segments carry French names
// (José, René); TTS speaks them fine. Digits, @, symbols and emoji still reject.

import { parsePhoneList } from "./campaignV2Shared";

export function cleanFirstName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  if (!/^[\p{L}'-]{2,20}$/u.test(first)) return null;
  const lower = first.toLocaleLowerCase();
  // Capitalize after start / hyphen / apostrophe: jean-luc → Jean-Luc, o'brien → O'Brien.
  return lower.replace(/(^|[-'])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase());
}

/**
 * VOZ-539 (2026-09-17): the E.164 numbers Vapi's `call.customer` could be, for a
 * `phone_e164 IN (...)` lookup against the campaign's contact rows.
 *
 * Only the CA route reaches Vapi as clean E.164, so only CA carries
 * customer.number. SquareTalk's AU/NZ routes want a dial prefix, and the SIP
 * user part arrives as "220161474271005" for +61474271005 — Vapi cannot parse
 * that, omits customer.number, and a seed that read only that field never
 * matched a contact row (CA 100% seeded, NZ/AU ~4%). processEndOfCall already
 * handles the same carrier habit with a suffix match (its strategy 3b); this is
 * that match expressed as a candidate set — every 8–15 digit suffix of the SIP
 * user — so one indexed query answers it. The caller must still insist on
 * EXACTLY ONE matching row: two hits mean we do not know who is on the line.
 */
export function customerE164Candidates(customer: unknown): string[] {
  const c = customer as { number?: unknown; sipUri?: unknown } | null | undefined;
  const out = new Set<string>();
  if (typeof c?.number === "string") for (const n of parsePhoneList(c.number)) out.add(n);
  if (typeof c?.sipUri === "string") {
    const digits = (/^sip:([^@]+)@/.exec(c.sipUri)?.[1] ?? "").replace(/[^0-9]/g, "");
    for (let len = 8; len <= 15 && len <= digits.length; len++) out.add("+" + digits.slice(-len));
  }
  return [...out];
}
