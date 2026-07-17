// Greet-by-name Ramp 2 (2026-07-17): {{variable}} substitution for outgoing
// script content. Values come from lab_call_flow_state.variables (seeded per
// call by the script-call route — e.g. playerName from the campaign contact's
// display_name via cleanFirstName). Applied at the PUSH points (handleWebhook
// inject cluster + lab-watchdog deliveries) where the flow state is already in
// hand — never adds a DB read to the latency-critical injection path.
//
// Missing/empty variable → the token is STRIPPED and the seam tidied (collapse
// doubled spaces, drop the space before punctuation), so an unauthored name
// yields the same natural line and the agent never speaks "{{playerName}}".
// Script authors opt in by writing {{playerName}} where a bare removal stays
// grammatical ("Hi {{playerName}}, it's Tom" → "Hi, it's Tom").

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function substituteVars(
  text: string,
  vars: Record<string, unknown> | null | undefined,
): string {
  if (!text.includes("{{")) return text; // fast path — most lines have no tokens
  const replaced = text.replace(TOKEN, (_m, key: string) => {
    const v = vars?.[key];
    return typeof v === "string" && v.trim() ? v.trim() : "";
  });
  // Tidy the seams left by stripped tokens — MID-LINE only: armed briefings are
  // newline-joined, indented bullet menus, so the tidy must never eat a newline
  // (would merge two menu options) nor line-leading indentation (review finding
  // 2026-07-17). The lookbehind pins the collapse to runs after a non-space.
  return replaced
    .replace(/(?<=\S)[ \t]{2,}/g, " ")   // doubled spaces from mid-sentence strips
    .replace(/[ \t]+([,.;:!?])/g, "$1")  // "Hi , it's" → "Hi, it's"; "Thanks !" → "Thanks!"
    .trim();
}
