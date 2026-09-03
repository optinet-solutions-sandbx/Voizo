// Player search results, grouped by PLAYER (Jasiel 2026-09-03). The lookup route answers with one
// hit per campaign_number, so a player who sat in three runs came back three times and the list
// read as clutter. One entry per phone number, its runs underneath, newest first.
// Pure, relative imports only (vitest has no "@/" alias).

export interface PlayerHit {
  numberId: string;
  campaignId: string;
  phone: string;
  displayName: string | null;
  outcome: string | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  smsSent: boolean;
}

export interface RunDescription {
  /** The run's label as the table shows it (family label, or the run's display name). */
  label: string;
  /** The run's day, "YYYY-MM-DD", or null when unknown. */
  dateIso: string | null;
  /** The contact's outcome in that run, as a word. */
  outcomeLabel: string;
}

export interface PlayerRun extends PlayerHit, RunDescription {}

export interface Player {
  phone: string;
  name: string | null;
  runs: PlayerRun[];
  attempts: number;
  lastAttemptedAt: string | null;
  smsSent: boolean;
  /** The outcome of the most recent run: what happened last. */
  latestOutcomeLabel: string;
}

const later = (a: string | null, b: string | null): number => {
  if (a === b) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;
  return a < b ? 1 : -1; // ISO strings compare as dates; descending
};

export function groupPlayers(hits: readonly PlayerHit[], describe: (campaignId: string) => RunDescription): Player[] {
  const byPhone = new Map<string, Player>();
  for (const h of hits) {
    const run: PlayerRun = { ...h, ...describe(h.campaignId) };
    const p = byPhone.get(h.phone);
    if (!p) {
      byPhone.set(h.phone, { phone: h.phone, name: h.displayName, runs: [run], attempts: h.attemptCount, lastAttemptedAt: h.lastAttemptedAt, smsSent: h.smsSent, latestOutcomeLabel: run.outcomeLabel });
      continue;
    }
    p.runs.push(run);
    p.attempts += h.attemptCount;
    p.smsSent = p.smsSent || h.smsSent;
    if (!p.name && h.displayName) p.name = h.displayName;
    if (later(h.lastAttemptedAt, p.lastAttemptedAt) < 0) p.lastAttemptedAt = h.lastAttemptedAt;
  }
  const players = [...byPhone.values()];
  for (const p of players) {
    // newest run first: by run day, then by last attempt
    p.runs.sort((a, b) => later(a.dateIso, b.dateIso) || later(a.lastAttemptedAt, b.lastAttemptedAt));
    p.latestOutcomeLabel = p.runs[0].outcomeLabel;
  }
  // most recently touched player first; never-called players last, by name
  players.sort((a, b) => later(a.lastAttemptedAt, b.lastAttemptedAt) || (a.name ?? "").localeCompare(b.name ?? ""));
  return players;
}
