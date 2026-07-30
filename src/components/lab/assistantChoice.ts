// Which agent the lab config form should have selected — a pure module (no
// React/DOM) so vitest can read it without a browser environment.
//
// VOZ-253: /api/vapi-assistants returns exactly the ONE assistant the lab's
// write routes will accept. lab_settings.lab_assistant_id is only a convenience
// echo of the last id that was configured, so it goes stale the moment the lab
// is pointed somewhere else — which is precisely what setting
// VAPI_LAB_ASSISTANT_ID does. Preselecting that stale id would send it on Save
// and earn a 403 with no hint as to why, so the OFFERED agent wins.

/** Resolve the selection: keep `stored` if it is still on offer, else take the offered agent. */
export function reconcileAssistantId(stored: string, offered: { id: string }[]): string {
  // Empty list = not loaded yet, or the fetch failed and an error is already on
  // screen. Never overwrite the operator's selection on a blank read.
  if (offered.length === 0) return stored;
  return offered.some((a) => a.id === stored) ? stored : offered[0].id;
}
