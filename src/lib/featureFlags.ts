// Centralized env-var-driven feature flags. Adding a new flag = adding a
// new function here + reading process.env. Keeps the flag-check pattern
// uniform and testable later.

/**
 * Controls whether Pause / outside-window auto-pause releases the SIP slot
 * and deletes the Vapi clone (true) or keeps them alive across the paused
 * period (false — today's behavior).
 *
 * Default: false. Flip to "true" only after Phase 1 sandbox verification
 * (docs/2026-05-25_DOC_SIP_Slot_Release_On_Pause.md §9 phased rollout).
 */
export function pauseReleasesSlot(): boolean {
  return process.env.PAUSE_RELEASES_SLOT === "true";
}
