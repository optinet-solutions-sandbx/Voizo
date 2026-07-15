// Content types a Step box can hold — a pure module (no React/DOM) so the
// runtime and vitest can read them without pulling the canvas + its browser deps.
export type Content =
  | "scenario"
  | "collection"
  | "subworkflow"
  | "wait"
  | "noop"
  | "send_sms"
  | "transfer"
  | "return"
  | "end";

export const CONTENT_META: Record<Content, { label: string; color: string; terminal?: boolean }> = {
  scenario: { label: "Scenario", color: "border-indigo-500 bg-indigo-500/10" },
  collection: { label: "Collection", color: "border-fuchsia-500 bg-fuchsia-500/10" },
  subworkflow: { label: "Sub-workflow", color: "border-teal-500 bg-teal-500/10" },
  wait: { label: "Wait", color: "border-sky-500 bg-sky-500/10" },
  noop: { label: "No-op", color: "border-gray-500 bg-gray-500/10" },
  send_sms: { label: "Send SMS", color: "border-amber-500 bg-amber-500/10" },
  transfer: { label: "Transfer", color: "border-orange-500 bg-orange-500/10", terminal: true },
  return: { label: "Return result", color: "border-lime-500 bg-lime-500/10", terminal: true },
  end: { label: "End Call", color: "border-rose-500 bg-rose-500/10", terminal: true },
};

// Legacy/unknown content types (e.g. "ifelse"/"loop" — dropped from the union
// but still present in older saved scripts) index CONTENT_META to `undefined`,
// and reading `.terminal`/`.color` off that used to crash the whole canvas.
// Fall back to scenario styling so the box renders benign + visible instead.
// ponytail: scenario fallback, no distinct "legacy" badge — add one only if
// operators need to spot-and-migrate old nodes.
export function metaOf(content: Content) {
  return CONTENT_META[content] ?? CONTENT_META.scenario;
}
