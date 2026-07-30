/**
 * Which Vapi assistant the Script Builder lab may read and write (VOZ-253).
 *
 * The lab used to operate directly on VAPI_SCRIPT_BASE_ASSISTANT_ID — the ONE
 * assistant every script campaign clones from (team decision 2026-07-22, so a
 * ▶ test call sounded exactly like production). The price of that sharing was
 * that every lab Save rewrote the donor, and the next spawn inherited it:
 * the voice (the 2026-07-28 female-voice incident — 112 answered calls heard a
 * woman introduce herself as Victor), and also the system prompt, the tools,
 * the transcriber keyterms and all three speaking plans. Pinning fields one at
 * a time only ever covers the field we were already burned by.
 *
 * Setting VAPI_LAB_ASSISTANT_ID points the lab at its own assistant and ends
 * the class. Left unset this resolves to the donor exactly as before, so the
 * change is inert until the env var exists. Create that assistant by CLONING
 * base Val, so the lab starts identical to production and only drifts as the
 * lab is actually used.
 *
 * Clone paths deliberately do NOT use this — createClone, the clone route,
 * campaignV2Data and recurringSpawn must keep reading
 * VAPI_SCRIPT_BASE_ASSISTANT_ID, which stays the production donor.
 */
export const labAssistantId = (): string | undefined =>
  process.env.VAPI_LAB_ASSISTANT_ID || process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;

/** Env var names, in resolution order — for error messages that have to tell an operator what to set. */
export const LAB_ASSISTANT_ENV_HINT = "VAPI_LAB_ASSISTANT_ID (or VAPI_SCRIPT_BASE_ASSISTANT_ID)";
