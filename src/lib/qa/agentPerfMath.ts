// src/lib/qa/agentPerfMath.ts
// PURE agent-performance aggregation over qa_scores — NO I/O, no env (mirrors
// northStarMath.ts / qaScoreMath.ts). The reader (agentPerfData.ts) fetches rows; this
// computes: verdict mix, top failure themes (rule-based clustering of the judge's
// rationale), per-base-agent rollup. Read-only observability, off the call path.
//
// THE THEMES ARE A HEURISTIC over the CURRENT judge wording, validated against all 71
// real failure rationales (2026-06-09): agent_no_consent 16, minimal_reply 20,
// not_recognized 14, declined 12, no_time 5, cant_afford 1, other 3 (4%). If the judge
// prompt changes materially, revisit (cheap: pure fn + tests).

export type FailureTheme =
  | "agent_no_consent"
  | "minimal_reply"
  | "not_recognized"
  | "declined"
  | "no_time"
  | "cant_afford"
  | "other";

export const THEME_LABEL: Record<FailureTheme, string> = {
  agent_no_consent: "Agent didn't lock in consent",
  minimal_reply: "Only a minimal reply / never engaged",
  not_recognized: "Didn't recognize us / wrong person",
  declined: "Said no / not interested",
  no_time: "No time right now / call back later",
  cant_afford: "Couldn't afford it",
  other: "Other (needs review)",
};

// The judge appends a boilerplate failure-tail ("never agreed to receive details, log
// in, activate a bonus, deposit, or return to play") to ~every failure rationale —
// that's the DEFINITION of failure, not a theme. Strip it first so rules key on the
// LEADING clause (the decisive customer/agent behavior), not the boilerplate.
function stripFailureTail(s: string): string {
  let t = (s || "").toLowerCase();
  t = t.replace(
    /(never |did not |didn'?t |no )?(agree(d|ment)?|consent)[^.]*?(receive (offer )?details|log ?in)[^.]*?(play|deposit|bonus)\b\.?/g,
    " ",
  );
  t = t.replace(
    /receive (offer )?details,? log ?in,?( activate( a| the)?( bonus| spins)?,?)?( deposit,?)?( or)?( return to play| play)?/g,
    " ",
  );
  return t.replace(/\s+/g, " ").trim();
}

// Ordered most-specific → least; FIRST MATCH WINS. This exact order reproduces the
// validated distribution — do not reorder without re-validating. Notably `declined`
// (which includes \bno\b) sits BEFORE `no_time`: real "no time" rationales are phrased
// "did not have time" (no standalone "no"), so they correctly reach no_time; a row that
// literally says the customer "said No" is a decline regardless of any time mention.
const THEMES: Array<[FailureTheme, RegExp]> = [
  [
    "agent_no_consent",
    /agent (unilaterally|never|ended|asked|offered|began|repeated|presented)|transcript ends? (before|after)|ends? (after|before) the agent|without any customer (agreement|assent)|never presented an offer|unilaterally|agent (asks?|asked) (for|to send)|before the agent (ended|repeated|asks)/,
  ],
  [
    "not_recognized",
    /not (their|theirs|mine)|account (is |was )?not|asked for deletion|delete (the|my)|(number|registration) (is |was |did )?(wrong|not)|wrong number|denied (registering|recognizing)|did(n'?t| not) recognize|not recognize|do(es)? not recognize|not (sound )?familiar|did(n'?t| not) sound familiar|not registered|suspicion|confus/,
  ],
  [
    "declined",
    /declin|no,? thanks|\bno\b|not interested|did not like|rejected|requested not to be called|do not call|hang up|negativ|no longer|don'?t play|do not play|\bnah\b/,
  ],
  [
    "no_time",
    /working|at work|no(t)? (have )?(time|thirty seconds)|thirty seconds|busy|try (again )?later|call (back|me) later|\blater\b|son.*hospital/,
  ],
  ["cant_afford", /broke|no cash|can'?t afford|no money|out of (money|funds)/],
  [
    "minimal_reply",
    /only (said|replied|responded|greeted|acknowledg|confirm|gave)|hello\??|thanks?\b|thank you|okay|yep\b|just (said|replied)|number-like|unclear (numbers|reply|number)|brief responses|goodbye|good night|\bbye\b|vague .?yes.?|three five|audio message|leave a message/,
  ],
];

export function bucketFailureTheme(rationale: string): FailureTheme {
  const t = stripFailureTail(rationale);
  for (const [name, re] of THEMES) if (re.test(t)) return name;
  if (t.length < 25) return "minimal_reply"; // residual was almost all boilerplate
  return "other";
}

export interface FailureThemeCount {
  theme: FailureTheme;
  label: string;
  count: number;
  pct: number; // share of failures, 0..1 (4dp)
  examples: string[]; // ≤3 raw rationales
}

export function topFailureThemes(rationales: string[]): FailureThemeCount[] {
  const buckets = new Map<FailureTheme, { count: number; examples: string[] }>();
  for (const r of rationales) {
    const theme = bucketFailureTheme(r);
    let b = buckets.get(theme);
    if (!b) {
      b = { count: 0, examples: [] };
      buckets.set(theme, b);
    }
    b.count++;
    if (b.examples.length < 3 && r && r.trim()) b.examples.push(r.trim());
  }
  const total = rationales.length;
  return [...buckets.entries()]
    .map(([theme, b]) => ({
      theme,
      label: THEME_LABEL[theme],
      count: b.count,
      pct: total > 0 ? Number((b.count / total).toFixed(4)) : 0,
      examples: b.examples,
    }))
    .sort((a, b) => b.count - a.count);
}

export interface VerdictMix {
  success: number;
  failure: number;
  unsure: number;
  unscored: number;
  total: number;
  successPct: number | null;
  failurePct: number | null;
  unsurePct: number | null;
}

export function computeVerdictMix(verdicts: Array<string | null | undefined>): VerdictMix {
  let success = 0;
  let failure = 0;
  let unsure = 0;
  let unscored = 0;
  for (const v of verdicts) {
    if (v === "success") success++;
    else if (v === "failure") failure++;
    else if (v === "unsure") unsure++;
    else unscored++;
  }
  const total = verdicts.length;
  // Percentages are over DECIDED verdicts (success+failure+unsure) so won+lost+unsure
  // sum to 100%; `unscored` (null / non-conversation rows) is reported separately, not
  // baked into the denominator.
  const scored = success + failure + unsure;
  const div = (n: number) => (scored > 0 ? Number((n / scored).toFixed(4)) : null);
  return { success, failure, unsure, unscored, total, successPct: div(success), failurePct: div(failure), unsurePct: div(unsure) };
}

export interface CampaignMeta {
  baseAssistantId: string | null;
  name: string;
  isTest: boolean;
}

export interface ScoreRowForRollup {
  campaign_id: string | null;
  success_verdict: string | null;
  axis_accuracy: number | null;
  axis_clarity: number | null;
  axis_natural_flow: number | null;
}

export interface AgentRollup {
  baseAssistantId: string; // real id or "unattributed"
  shortId: string; // first 8 chars, or "unattributed"
  campaignNames: string[]; // distinct, sorted
  scored: number;
  success: number;
  failure: number;
  unsure: number;
  successPct: number | null;
  failurePct: number | null;
  unsurePct: number | null;
  avgAccuracy: number | null;
  avgClarity: number | null;
  avgNaturalFlow: number | null;
}

const UNATTRIBUTED = "unattributed";

export function rollupByBaseAgent(rows: ScoreRowForRollup[], campaignMeta: Map<string, CampaignMeta>): AgentRollup[] {
  interface Acc {
    scored: number;
    success: number;
    failure: number;
    unsure: number;
    accSum: number;
    accN: number;
    claSum: number;
    claN: number;
    flowSum: number;
    flowN: number;
    names: Set<string>;
  }
  const groups = new Map<string, Acc>();
  for (const r of rows) {
    const meta = r.campaign_id ? campaignMeta.get(r.campaign_id) : undefined;
    if (meta?.isTest) continue; // exclude test traffic
    const key = meta?.baseAssistantId ?? UNATTRIBUTED;
    let g = groups.get(key);
    if (!g) {
      g = { scored: 0, success: 0, failure: 0, unsure: 0, accSum: 0, accN: 0, claSum: 0, claN: 0, flowSum: 0, flowN: 0, names: new Set() };
      groups.set(key, g);
    }
    g.scored++;
    if (r.success_verdict === "success") g.success++;
    else if (r.success_verdict === "failure") g.failure++;
    else if (r.success_verdict === "unsure") g.unsure++;
    if (r.axis_accuracy != null) {
      g.accSum += r.axis_accuracy;
      g.accN++;
    }
    if (r.axis_clarity != null) {
      g.claSum += r.axis_clarity;
      g.claN++;
    }
    if (r.axis_natural_flow != null) {
      g.flowSum += r.axis_natural_flow;
      g.flowN++;
    }
    if (meta?.name) g.names.add(meta.name);
  }
  const avg = (sum: number, n: number) => (n > 0 ? Number((sum / n).toFixed(2)) : null);
  const div = (n: number, d: number) => (d > 0 ? Number((n / d).toFixed(4)) : null);
  return [...groups.entries()]
    .map(([key, g]) => ({
      baseAssistantId: key,
      shortId: key === UNATTRIBUTED ? UNATTRIBUTED : key.slice(0, 8),
      campaignNames: [...g.names].sort(),
      scored: g.scored,
      success: g.success,
      failure: g.failure,
      unsure: g.unsure,
      successPct: div(g.success, g.scored),
      failurePct: div(g.failure, g.scored),
      unsurePct: div(g.unsure, g.scored),
      avgAccuracy: avg(g.accSum, g.accN),
      avgClarity: avg(g.claSum, g.claN),
      avgNaturalFlow: avg(g.flowSum, g.flowN),
    }))
    .sort((a, b) => b.scored - a.scored);
}
