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

export function cleanFirstName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.trim().split(/\s+/)[0] ?? "";
  if (!/^[\p{L}'-]{2,20}$/u.test(first)) return null;
  const lower = first.toLocaleLowerCase();
  // Capitalize after start / hyphen / apostrophe: jean-luc → Jean-Luc, o'brien → O'Brien.
  return lower.replace(/(^|[-'])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toLocaleUpperCase());
}
