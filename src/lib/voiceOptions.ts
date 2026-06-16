// Voice ID → friendly name. SINGLE SOURCE OF TRUTH — the campaign wizard (StepAgent)
// and the analytics dashboard both import this. Ported from page-classic; keep in sync
// with the voices configured in Vapi. Used ONLY for display (never sent to clone — R3).

export const VOICE_OPTIONS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "3jR9BuQAOPMWUjWpi0ll", name: "Stephen – Sales and Customer Service" },
  { id: "UgBBYS2sOqTuMpoF3BR0", name: "Mark – Dynamic, Balanced and Emotional" },
  { id: "6YQMyaUWlj0VX652cY1C", name: "Mark – Natural Conversations" },
  { id: "2zGvynULFssveGrcP8hi", name: "Jackson – American Tech Sales Rep" },
  { id: "YaarrMwvJxVUpjbZ2RpC", name: "George – Natural, Full and Confident" },
  { id: "pHqSZYhjNK8nDCPRglTL", name: "Alex – Professional" },
  { id: "1IthILLNX448pH19aMvC", name: "Matthew Logovik" },
  { id: "pNInz6obpgDQGcFmaJgB", name: "Adam – Default" },
];

const BY_ID = new Map(VOICE_OPTIONS.map((v) => [v.id, v.name]));

/** Friendly voice name for a voice_id. `short` returns just the persona (text before
 *  the first dash) — e.g. "Stephen". Returns null for null/unknown ids (caller falls back). */
export function voiceName(voiceId: string | null | undefined, opts?: { short?: boolean }): string | null {
  if (!voiceId) return null;
  const full = BY_ID.get(voiceId);
  if (!full) return null;
  return opts?.short ? full.split(/[–-]/)[0].trim() : full;
}
