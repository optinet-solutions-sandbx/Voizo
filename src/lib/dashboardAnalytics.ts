/**
 * dashboardAnalytics — PURE, React-free aggregation for the unified Voizo Dashboard
 * (Val's spec, 2026-06-15). No I/O; `now` is injected so the module stays testable.
 *
 * Definitions (LOCKED — Jasiel/Val 2026-06-15, "be true to our numbers"):
 *   connected ("Answer")  = calls_v2.status IN CONNECTED_STATUSES (== 'completed'; INCLUDES
 *                           voicemail, which lands as 'completed'). Labeled "Answer" in the UI.
 *   connectRate           = connected / terminal   (terminal excludes in-flight: initiated/queued/ringing)
 *   successful            = goal_reached === true
 *   successRate           = successful / connected  ← off CONNECTED, everywhere (Val's non-negotiable)
 *   Reach % (human-only)  = DEFERRED — needs a persisted voicemail signal (separate reviewed slice).
 *
 * Segregation: ghost runs (campaigns_v2.source === 'ghost_portal') are NEVER counted — hard
 * exclusion in every path. Test campaigns (is_test) are excluded from KPIs/best by default.
 *
 * Reuses campaignAnalytics.ts as the single source of truth for the connect/success classification.
 * DEFERRED to later slices (same `rollup` primitive): prompt-version attribution + rollup,
 * trend series, daily-volume, date×hour heatmap.
 */
import {
  safeDiv,
  parseCountryToken,
  CONNECTED_STATUSES,
  TERMINAL_NONCONNECT,
} from "./campaignAnalytics";
import { ANALYTICS_CONFIG, isAgentTimeout } from "./analyticsConfig";
import { substantiveUserTurnCount } from "./transcriptClassify";
import { formatCampaign } from "./campaignDisplay";

const MS_PER_DAY = 86_400_000;

// ── Input row shapes (only the columns the dashboard selects) ────────────────
export interface DashCallRow {
  id?: string | null; // calls_v2.id — join key for sms_messages_v2.call_id (Today SMS breakdown)
  campaign_id: string;
  campaign_number_id?: string | null;
  status?: string | null;
  goal_reached?: boolean | null;
  created_at?: string | null; // ISO
  voicemail?: boolean | null; // calls_v2.voicemail (transcript-detected); NULL = not evaluated (historical/pre-deploy)
  duration_seconds?: number | null; // calls_v2.duration_seconds — < EARLY_HANGUP_SEC ⇒ early hangup
  ended_reason?: string | null; // calls_v2.ended_reason — 'customer-ended-call' marks a customer hangup
  transcript?: { text?: string | null } | string | null; // calls_v2.transcript (jsonb {text}); engagement signal
}
export interface DashCampaignRow {
  id: string;
  name: string;
  status?: string | null; // running | paused | completed | inactive | draft ...
  source?: string | null; // 'ghost_portal' => hard-excluded
  is_test?: boolean | null;
  campaign_type?: string | null; // 'fixed' | 'recurring'
  voice_id?: string | null; // ElevenLabs voice
  vapi_assistant_name?: string | null; // the CLONE name (== campaign name); not used for display
  base_assistant_id?: string | null; // the BASE agent this clone came from — resolved to a real name in the UI
  cio_workspace?: string | null; // brand routing label (VOZ-198); NULL = the default brand. Display via brandLabel().
  start_at?: string | null;
  created_at?: string | null;
  end_at?: string | null;
  timezone?: string | null; // IANA tz for local-time heatmap bucketing (falls back to UTC when absent)
  // Campaign Performance filters (Val 2026-08-07): script + segment identity.
  script_id?: string | null;
  script_name?: string | null;
  segment_id?: string | null;
}
export interface DashSmsRow {
  campaign_id: string;
  created_at?: string | null;
  status?: string | null;
  call_id?: string | null; // sms_messages_v2.call_id — links the text to the call that triggered it
  campaign_number_id?: string | null; // fallback contact link
}

export interface DashFilters {
  startMs: number; // window start (inclusive)
  endMs: number; // window end (inclusive)
  campaignIds?: string[] | null; // null/undefined = all
  voiceId?: string | null; // single agent (campaign.voice_id)
  baseAssistantId?: string | null; // single BASE agent (campaign.base_assistant_id) — Top Performers drill (Slice E)
  numberIds?: string[] | null; // phone-lookup, pre-resolved to campaign_number_ids
  includeTest?: boolean; // default false (test excluded from the client view)
}

// ── Output shapes ────────────────────────────────────────────────────────────
export interface RateRow {
  calls: number; // total calls in scope
  connected: number; // status ∈ CONNECTED_STATUSES (== Answer, incl. voicemail)
  terminal: number; // connected + terminal-nonconnect (connectRate denominator)
  successful: number; // goal_reached === true
  connectRate: number | null; // connected / terminal
  successRate: number | null; // successful / connected
  // voicemail / reach (call-observability slice) — connected-gated, null-safe over evaluated calls.
  // Mirrors campaignAnalytics' locked defs so the dashboard layer stays a single source of truth.
  voicemailConnected: number; // connected calls flagged voicemail===true
  voicemailEvaluated: number; // connected calls with a non-null voicemail flag (true|false)
  reach: number; // human-only connects = connected − voicemailConnected (unevaluated count as reached)
  voicemailRate: number | null; // voicemailConnected / voicemailEvaluated (NULL until calls are evaluated)
  positiveResponseRate: number | null; // successful / reach — "agreed to the offer" over humans reached (NOT goal/connected)
}

export interface CampaignRollup extends RateRow {
  id: string;
  name: string;
  country: string;
  status: string; // raw campaigns_v2.status
  scheduleType: "fixed" | "recurring";
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  startAt: string | null; // COALESCE(start_at, created_at)
  endAt: string | null;
  lastCallAtMs: number | null; // most recent call created_at in scope (for the Finished derivation)
}

// Derived DISPLAY status (Jasiel 2026-06-15): campaigns collapse to three reporting states —
// Running (live), Paused (recently active / resumable), Finished (ran-then-done: past-end or
// idle — AND never-ran draft/inactive, folded in). PRESENTATION-ONLY — never mutates
// campaigns_v2.status or the scheduler. Completed+Ended→Finished, then Inactive→Finished (2026-07-03).
export type DisplayStatus = "running" | "scheduled" | "paused" | "finished";

// A paused campaign idle (no calls) for this many days reads as "Finished", so paused campaigns
// don't pile up (Jasiel 2026-07-03; was 7). Single source for the idle window — the API route, the
// table default, and the derivation all reference this so the policy can't drift across three spots.
export const FINISHED_IDLE_DAYS = 2;

export function deriveDisplayStatus(opts: {
  rawStatus: string | null;
  endAtMs: number | null;
  lastCallMs: number | null;
  nowMs: number;
  idleDays?: number;
  // A recurring PARENT with status='running' is an armed SCHEDULE, not a
  // dialing campaign (its day-children dial). Show it as "Scheduled" so the
  // analytics tables match the campaigns list + always-on section.
  isRecurringParent?: boolean;
}): DisplayStatus {
  const { rawStatus, endAtMs, lastCallMs, nowMs, idleDays = FINISHED_IDLE_DAYS, isRecurringParent } = opts;
  const s = (rawStatus ?? "").toLowerCase();
  if (s === "running") return isRecurringParent ? "scheduled" : "running"; // trust a live status
  if (s === "inactive" || s === "draft") return "finished"; // never-ran folded into Finished (2026-07-03)
  if (s === "completed" || s === "archived") return "finished";
  if (endAtMs !== null && endAtMs <= nowMs) return "finished"; // reached its scheduled end
  if (s === "paused") {
    const idleMs = idleDays * MS_PER_DAY;
    if (lastCallMs === null || nowMs - lastCallMs >= idleMs) return "finished"; // stale → done
    return "paused";
  }
  return "paused"; // unknown non-terminal → treat as paused
}

export interface AgentRollup extends RateRow {
  baseAssistantId: string; // grouping key — the BASE agent the clones came from (resolved to a name in the UI)
  campaignCount: number;
}

export interface BestPerformer {
  key: string;
  label: string;
  positiveResponseRate: number; // goal_reached / reach — the metric the "Best" cards rank + display
  calls: number;
}

export interface RunningCampaignCard {
  id: string;
  name: string;
  country: string;
  cioWorkspace: string | null; // brand label (VOZ-216) — raw workspace; UI renders via brandLabel()
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  scheduleType: "fixed" | "recurring"; // drives the "recurring" marker on the shared camp-row
  today: RateRow;
  startAt: string | null; // run-window start — drives the "running for X" runtime (Slice A)
  players: number; // campaign roster size (route-supplied; 0 when unavailable)
  perf: TodayPerfDay; // per-campaign today breakdown (no deltas) for the Today's-campaigns rows
}

// ── Today's Performance 3-card model (Val's mockup, 2026-06-29) ──────────────
export interface PerfRow {
  key: string;
  label: string;
  count: number;
  pct: number | null; // share of the card denominator (CallAttempts→total; Reached→reach; SMS→total; sub-row→SMS-reached)
  deltaPpVsYesterday: number | null; // pp change of this row's rate vs the prior day
  deltaPpVsSevenDayAvg: number | null; // pp change vs the pooled 7-day rate
  isEstimated?: boolean; // proxy outcome bucket → drives the "Estimated" tooltip
  subRows?: PerfRow[]; // SMS "by response" sub-breakdown (lives under the Reached row)
}
export interface PerfMetric {
  total: number;
  deltaPctVsYesterday: number | null; // % change of the total vs the prior day
  deltaPctVsSevenDayAvg: number | null; // % change vs the mean daily total over the prior 7 days
  rows: PerfRow[];
}
export interface TodayPerfDay {
  callAttempts: PerfMetric;
  reached: PerfMetric;
  sms: PerfMetric;
  inFlight: number; // calls still dialing (rendered as "+N in progress", never as Unreachable)
}

export interface TodaySnapshot {
  dayUtc: string; // YYYY-MM-DD (UTC)
  today: TodayPerfDay; // 3-card block for today (the toggle default)
  yesterday: TodayPerfDay; // same block for yesterday (toggle)
  runningCampaigns: RunningCampaignCard[];
  ops: {
    callsToday: number;
    callsYesterday: number;
    deltaVsYesterday: number | null; // fraction; null when yesterday == 0
    sevenDayAvg: number; // mean daily calls over the prior 7 days (excl. today)
    deltaVsSevenDayAvg: number | null;
    connectRateToday: number | null;
    connectedToday: number; // numerator for "X of Y"
    terminalToday: number; // denominator for "X of Y"
    // Reach / voicemail (call-observability slice) — connected-gated, null-safe; fill forward from deploy.
    reachToday: number; // human-only connects today = connectedToday − voicemailConnectedToday
    voicemailConnectedToday: number; // connected calls today flagged voicemail===true
    voicemailEvaluatedToday: number; // connected calls today with a non-null voicemail flag
    voicemailRateToday: number | null; // voicemailConnectedToday / voicemailEvaluatedToday (NULL until evaluated)
    messagesSentToday: number;
    messagesShareOfCalls: number | null; // sent / callsToday
    messagesShareOfConnected: number | null; // sent / connectedToday
    activeAgents: number; // distinct voice_id among running campaigns
    totalAgents: number; // distinct voice_id across all (non-ghost) campaigns
    idleAgents: number; // totalAgents - activeAgents
    runningCampaignCount: number;
  };
}

// ── Classification (single source of truth via campaignAnalytics) ────────────
function isConnected(status: string | null | undefined): boolean {
  return CONNECTED_STATUSES.has(status ?? "");
}
function isTerminal(status: string | null | undefined): boolean {
  const s = status ?? "";
  return CONNECTED_STATUSES.has(s) || TERMINAL_NONCONNECT.has(s);
}

function emptyRate(): RateRow {
  return {
    calls: 0, connected: 0, terminal: 0, successful: 0, connectRate: null, successRate: null,
    voicemailConnected: 0, voicemailEvaluated: 0, reach: 0, voicemailRate: null, positiveResponseRate: null,
  };
}

function accumulate(row: RateRow, c: DashCallRow): void {
  row.calls += 1;
  if (isConnected(c.status)) {
    row.connected += 1;
    // Voicemail/reach: only CONNECTED ('completed') calls can be a voicemail. NULL = not
    // evaluated (historical/pre-deploy) → excluded from the rate denominator.
    if (c.voicemail === true && c.goal_reached !== true) row.voicemailConnected += 1; // goal_reached overrides the voicemail flag (Val 2026-07-03)
    if (c.voicemail != null) row.voicemailEvaluated += 1;
  }
  if (isTerminal(c.status)) row.terminal += 1;
  if (c.goal_reached === true) row.successful += 1;
}

function finalizeRate(row: RateRow): RateRow {
  row.connectRate = safeDiv(row.connected, row.terminal);
  row.successRate = safeDiv(row.successful, row.connected);
  row.reach = row.connected - row.voicemailConnected; // unevaluated connects count as reached
  row.voicemailRate = safeDiv(row.voicemailConnected, row.voicemailEvaluated);
  row.positiveResponseRate = safeDiv(row.successful, row.reach); // goal over humans reached (not connected)
  return row;
}

/** Generic single-pass rollup: bucket calls by a key, return finalized RateRows.
 *  keyOf returning null drops the call from the rollup. This primitive powers the
 *  campaign / agent / (later) prompt / day / date-hour rollups. */
export function rollup<K>(calls: DashCallRow[], keyOf: (c: DashCallRow) => K | null): Map<K, RateRow> {
  const acc = new Map<K, RateRow>();
  for (const c of calls) {
    const k = keyOf(c);
    if (k === null) continue;
    let row = acc.get(k);
    if (!row) {
      row = emptyRate();
      acc.set(k, row);
    }
    accumulate(row, c);
  }
  for (const row of acc.values()) finalizeRate(row);
  return acc;
}

/** Flat KPIs over a call set (the global KPI grid's Row-1 numbers). */
export function computeKpis(calls: DashCallRow[]): RateRow {
  const row = emptyRate();
  for (const c of calls) accumulate(row, c);
  return finalizeRate(row);
}

// ── Campaign index + filtering ───────────────────────────────────────────────
export function buildCampaignIndex(campaigns: DashCampaignRow[]): Map<string, DashCampaignRow> {
  const idx = new Map<string, DashCampaignRow>();
  for (const c of campaigns) idx.set(c.id, c);
  return idx;
}

/** Apply the global filters to a call set. Ghost is ALWAYS dropped; test is dropped
 *  unless filters.includeTest. Date window is inclusive on both ends. */
export function filterCalls(
  calls: DashCallRow[],
  filters: DashFilters,
  index: Map<string, DashCampaignRow>,
): DashCallRow[] {
  const campaignIdSet = filters.campaignIds && filters.campaignIds.length ? new Set(filters.campaignIds) : null;
  const numberIdSet = filters.numberIds && filters.numberIds.length ? new Set(filters.numberIds) : null;
  const out: DashCallRow[] = [];
  for (const c of calls) {
    const camp = index.get(c.campaign_id);
    if (!camp) continue; // orphan call (campaign not in scope) — drop
    if (camp.source === "ghost_portal") continue; // hard ghost exclusion
    if (camp.is_test === true && !filters.includeTest) continue;
    if (campaignIdSet && !campaignIdSet.has(c.campaign_id)) continue;
    if (filters.voiceId && (camp.voice_id ?? null) !== filters.voiceId) continue;
    if (filters.baseAssistantId && (camp.base_assistant_id ?? null) !== filters.baseAssistantId) continue;
    if (numberIdSet && !(c.campaign_number_id && numberIdSet.has(c.campaign_number_id))) continue;
    const t = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isFinite(t) || t < filters.startMs || t > filters.endMs) continue;
    out.push(c);
  }
  return out;
}

// ── Campaign rollups ─────────────────────────────────────────────────────────
export function computeCampaignRollups(
  calls: DashCallRow[],
  index: Map<string, DashCampaignRow>,
): CampaignRollup[] {
  const byId = rollup(calls, (c) => c.campaign_id);
  const lastCall = new Map<string, number>();
  for (const c of calls) {
    const t = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const prev = lastCall.get(c.campaign_id);
    if (prev === undefined || t > prev) lastCall.set(c.campaign_id, t);
  }
  const out: CampaignRollup[] = [];
  for (const [id, rate] of byId) {
    const camp = index.get(id);
    if (!camp) continue;
    out.push({
      ...rate,
      id,
      name: camp.name,
      country: parseCountryToken(camp.name),
      status: camp.status ?? "draft",
      scheduleType: camp.campaign_type === "recurring" ? "recurring" : "fixed",
      voiceId: camp.voice_id ?? null,
      agentLabel: camp.vapi_assistant_name ?? null,
      baseAssistantId: camp.base_assistant_id ?? null,
      startAt: (camp.start_at ?? camp.created_at) ?? null,
      endAt: camp.end_at ?? null,
      lastCallAtMs: lastCall.get(id) ?? null,
    });
  }
  return out;
}

// ── Agent (voice) rollups ────────────────────────────────────────────────────
export function computeAgentRollups(
  calls: DashCallRow[],
  index: Map<string, DashCampaignRow>,
): AgentRollup[] {
  const byAgent = rollup(calls, (c) => index.get(c.campaign_id)?.base_assistant_id ?? null);
  // Count distinct campaigns per base agent.
  const campaignsByAgent = new Map<string, Set<string>>();
  for (const camp of index.values()) {
    if (camp.source === "ghost_portal" || !camp.base_assistant_id) continue;
    let set = campaignsByAgent.get(camp.base_assistant_id);
    if (!set) {
      set = new Set();
      campaignsByAgent.set(camp.base_assistant_id, set);
    }
    set.add(camp.id);
  }
  const out: AgentRollup[] = [];
  for (const [baseAssistantId, rate] of byAgent) {
    out.push({ ...rate, baseAssistantId, campaignCount: campaignsByAgent.get(baseAssistantId)?.size ?? 0 });
  }
  return out;
}

/** Best performer by positiveResponseRate (goal/reach), gated by a minimum connected-call volume
 *  so a 1–2 call campaign/agent can't show as "best" (Val's requirement). Returns null when none
 *  qualify. Renamed from bestBySuccess 2026-06-26 — "success" is retired in favour of positive response. */
export function bestByPositiveResponse<T extends RateRow>(
  rows: T[],
  labelOf: (r: T) => { key: string; label: string },
  minConnected = ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN,
): BestPerformer | null {
  let best: BestPerformer | null = null;
  for (const r of rows) {
    if (r.connected < minConnected || r.positiveResponseRate === null) continue;
    const { key, label } = labelOf(r);
    if (!best || r.positiveResponseRate > best.positiveResponseRate) {
      best = { key, label, positiveResponseRate: r.positiveResponseRate, calls: r.calls };
    }
  }
  return best;
}

// ── Global Performance KPI grid (reactive to the filters) ────────────────────
export interface GlobalKpis {
  kpis: RateRow;
  campaignCount: number; // distinct campaigns with >=1 call in the filtered scope
  bestCampaign: BestPerformer | null;
  bestAgent: BestPerformer | null; // key = base_assistant_id (UI resolves the name)
  campaignRollups: CampaignRollup[]; // for the Top-Campaigns leaderboard
  agentRollups: AgentRollup[]; // for the Agent ranked table
  // bestPrompt is deferred to the prompt-attribution slice.
}

/** Compose the Global Performance KPIs + rollups from an already-filtered call set. */
export function computeGlobalKpis(calls: DashCallRow[], index: Map<string, DashCampaignRow>): GlobalKpis {
  const campaignRollups = computeCampaignRollups(calls, index);
  const agentRollups = computeAgentRollups(calls, index);
  return {
    kpis: computeKpis(calls),
    campaignCount: new Set(calls.map((c) => c.campaign_id)).size,
    bestCampaign: bestByPositiveResponse(campaignRollups, (r) => ({ key: r.id, label: r.name })),
    bestAgent: bestByPositiveResponse(agentRollups, (r) => ({ key: r.baseAssistantId, label: r.baseAssistantId })),
    campaignRollups,
    agentRollups,
  };
}

// ── Prompt rollups (grouped by prompt content hash) ──────────────────────────
export interface PromptRollup extends RateRow {
  sha: string; // prompt content hash — the grouping key
  label: string; // "snippet… · a1b2"
  campaignCount: number;
  baseAssistantId: string | null; // representative base agent (UI resolves the name; null when unknown)
}

// The platform prefix (cloneAssistant.ts VOIZO_SYSTEM_PREFIX) is prepended to every cloned prompt
// and ALWAYS ends with this stable marker. We strip up to it rather than matching the whole prefix:
// the prefix text drifts over time (captured snapshots carry different prefix lengths) and Vapi can
// normalize whitespace, so an exact full-prefix startsWith silently failed and left boilerplate in
// the label. The end marker is the one fixed boundary (verified present in every captured prompt).
const SYSTEM_INSTRUCTIONS_END = "[End System Instructions]";

// Generous cap: the label fills its row and CSS-truncates to the panel width, so wide panels show
// more of the operator text and no dead gap opens before the right-aligned metrics. The UI surfaces
// the distinguishing sha separately (it would otherwise be the first thing a CSS-truncate hides).
const PROMPT_SNIPPET_MAX = 200;

/** The OPERATOR portion of a system prompt: everything after the platform prefix's stable end
 *  marker, trimmed. Prefix-less prompts pass through unchanged. Shared by promptLabel (snippets)
 *  and the prompt hover-preview (first lines). */
export function operatorPromptText(systemPrompt: string): string {
  const text = systemPrompt ?? "";
  const endIdx = text.indexOf(SYSTEM_INSTRUCTIONS_END);
  return (endIdx >= 0 ? text.slice(endIdx + SYSTEM_INSTRUCTIONS_END.length) : text).trim();
}

/** Short, human-ish label for a prompt: a snippet of its OPERATOR text + the first 4 sha chars.
 *  De-boilerplates via operatorPromptText; prefix-less prompts (no marker) are snippeted from the
 *  start unchanged. The UI prepends the base-agent name (resolved client-side) for the full
 *  "Tom · snippet · sha" label. */
export function promptLabel(systemPrompt: string, sha: string): string {
  const cleaned = operatorPromptText(systemPrompt).replace(/\s+/g, " ").trim();
  const snippet = cleaned.slice(0, PROMPT_SNIPPET_MAX);
  return `${snippet}${cleaned.length > PROMPT_SNIPPET_MAX ? "…" : ""} · ${(sha ?? "").slice(0, 4)}`;
}

/** Map each prompt sha → the FIRST non-null base agent id among the campaigns that ran it
 *  (null when none carry one). A given prompt sha is near-always one base agent's prompt; on the
 *  rare cross-base reuse we pick the first non-null so the UI can still resolve a name. Shared by
 *  computePromptRollups (table/card) and the route's filter-option list so both label identically. */
export function representativeBaseBySha(
  promptByCampaign: Map<string, { sha: string; baseAssistantId?: string | null }>,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const { sha, baseAssistantId } of promptByCampaign.values()) {
    const cur = out.get(sha);
    if (cur == null && baseAssistantId) out.set(sha, baseAssistantId);
    else if (!out.has(sha)) out.set(sha, null);
  }
  return out;
}

/** Group calls by their campaign's prompt content hash. promptByCampaign maps
 *  campaignId → {sha, label, baseAssistantId}. v1 uses per-campaign prompt identity (the campaign's
 *  current prompt); per-call time-based attribution (qaScoreMath) is a later refinement. */
export function computePromptRollups(
  calls: DashCallRow[],
  promptByCampaign: Map<string, { sha: string; label: string; baseAssistantId?: string | null }>,
): PromptRollup[] {
  const bySha = rollup(calls, (c) => promptByCampaign.get(c.campaign_id)?.sha ?? null);
  const baseBySha = representativeBaseBySha(promptByCampaign);
  const campaignsBySha = new Map<string, Set<string>>();
  const labelBySha = new Map<string, string>();
  for (const [campId, p] of promptByCampaign) {
    let set = campaignsBySha.get(p.sha);
    if (!set) {
      set = new Set();
      campaignsBySha.set(p.sha, set);
    }
    set.add(campId);
    if (!labelBySha.has(p.sha)) labelBySha.set(p.sha, p.label);
  }
  const out: PromptRollup[] = [];
  for (const [sha, rate] of bySha) {
    out.push({
      ...rate,
      sha,
      label: labelBySha.get(sha) ?? sha.slice(0, 8),
      campaignCount: campaignsBySha.get(sha)?.size ?? 0,
      baseAssistantId: baseBySha.get(sha) ?? null,
    });
  }
  return out;
}

// ── Trend over time (dual-axis Connect / Success per day) ────────────────────
export interface TrendPoint {
  day: string; // YYYY-MM-DD (UTC)
  connectRate: number | null;
  successRate: number | null;
  calls: number; // = call attempts that day
  reached: number; // human-only connects that day (connected − voicemail)
  smsSent: number; // offer texts sent|delivered that day
}

// "SMS sent" = accepted by the provider ('sent') or confirmed on the handset ('delivered').
// Excludes 'queued' (never handed off) and 'failed'/'undelivered' (never arrived). This is the
// ONE app-wide definition (2026-07-02) — it matches smsWindowBreakdown (the 3-card SMS metric)
// and the records-drawer "texted" slices, so every "SMS sent" number reconciles across surfaces.
const SMS_SENT_STATUSES = new Set(["sent", "delivered"]);
export function isSmsSent(status: string | null | undefined): boolean {
  return SMS_SENT_STATUSES.has(status ?? "");
}
/** Per-campaign count of sent|delivered SMS. Pure; shared by the campaign table, ranked tables, trend. */
export function smsSentByCampaign(sms: DashSmsRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sms) if (isSmsSent(s.status)) m.set(s.campaign_id, (m.get(s.campaign_id) ?? 0) + 1);
  return m;
}

/** Per-day attempts / reached / SMS-sent (+ legacy connect/success rates) over [startMs, endMs],
 *  zero-filled so the x-axis is even. `sms` drives the per-day SMS-sent series. */
export function computeTrend(calls: DashCallRow[], startMs: number, endMs: number, sms: DashSmsRow[] = []): TrendPoint[] {
  const byDay = rollup(calls, (c) => (c.created_at ? utcDayString(Date.parse(c.created_at)) : null));
  const smsByDay = new Map<string, number>();
  for (const s of sms) {
    if (!isSmsSent(s.status) || !s.created_at) continue;
    const t = Date.parse(s.created_at);
    if (!Number.isFinite(t)) continue;
    const d = utcDayString(t);
    smsByDay.set(d, (smsByDay.get(d) ?? 0) + 1);
  }
  const out: TrendPoint[] = [];
  const first = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  for (let t = first; t <= endMs; t += MS_PER_DAY) {
    const day = utcDayString(t);
    const r = byDay.get(day);
    out.push({
      day,
      connectRate: r?.connectRate ?? null,
      successRate: r?.successRate ?? null,
      calls: r?.calls ?? 0,
      reached: r?.reach ?? 0,
      smsSent: smsByDay.get(day) ?? 0,
    });
  }
  return out;
}

// ── Daily call volume (stacked by campaign COUNTRY) ──────────────────────────
export interface VolumeSeries {
  key: string; // country (friendly name, e.g. "Australia"), or "other"
  name: string;
}
export interface VolumeResult {
  days: Array<Record<string, number | string>>; // { day, [country|"other"]: count }
  series: VolumeSeries[]; // countries present, by volume, + an "Other" bucket (unparseable names)
}

/** Calls per day, stacked by campaign COUNTRY (best-effort L7_<CC>_ parse via formatCampaign;
 *  campaigns whose name has no parseable country fold into "other"). Grouping by country keeps the
 *  stack to a handful of stable, meaningful colors instead of a per-campaign rainbow (and the color
 *  no longer depends on volume rank). Zero-filled day range. */
export function computeDailyVolume(
  calls: DashCallRow[],
  campaigns: DashCampaignRow[],
  startMs: number,
  endMs: number,
): VolumeResult {
  const index = buildCampaignIndex(campaigns);
  const countryOf = (campId: string) => formatCampaign(index.get(campId)?.name ?? null).country || "other";

  const totalByCountry = new Map<string, number>();
  const byDay = new Map<string, Record<string, number>>();
  for (const c of calls) {
    if (!c.created_at) continue;
    const key = countryOf(c.campaign_id);
    totalByCountry.set(key, (totalByCountry.get(key) ?? 0) + 1);
    const day = utcDayString(Date.parse(c.created_at));
    let rec = byDay.get(day);
    if (!rec) {
      rec = {};
      byDay.set(day, rec);
    }
    rec[key] = (rec[key] ?? 0) + 1;
  }

  const days: Array<Record<string, number | string>> = [];
  const first = Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), new Date(startMs).getUTCDate());
  for (let t = first; t <= endMs; t += MS_PER_DAY) {
    const day = utcDayString(t);
    days.push({ day, ...(byDay.get(day) ?? {}) });
  }

  // Series: countries by total volume (desc); "other" always last so the neutral bucket sits at the
  // top of the stack. Color is assigned per-country in the chart (entity-keyed), not by this order.
  const series: VolumeSeries[] = [...totalByCountry.entries()]
    .filter(([k]) => k !== "other")
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => ({ key: k, name: k }));
  if (totalByCountry.has("other")) series.push({ key: "other", name: "Other" });
  return { days, series };
}

// ── Daily × hourly heatmap (call volume by date/hour + per-slot breakdown) ───
export interface HeatBreakdown {
  name: string; // raw campaign name (UI formats)
  calls: number;
  connected: number; // status ∈ CONNECTED_STATUSES (incl. voicemail)
  voicemailConnected: number; // connected calls flagged voicemail===true (Reached = connected − this)
  successful: number;
}
export interface HeatCell {
  day: string; // YYYY-MM-DD (UTC)
  hour: number; // 0..23 (UTC)
  calls: number;
  connected: number; // status ∈ CONNECTED_STATUSES (incl. voicemail)
  voicemailConnected: number; // connected calls flagged voicemail===true (Reached = connected − this)
  successful: number;
  breakdown: HeatBreakdown[]; // top campaigns in this slot (for the hover tooltip)
}

export interface HeatmapResult {
  cells: HeatCell[];
  localizedCalls: number; // calls bucketed in their campaign's local time
  utcFallbackCalls: number; // calls whose campaign has no/invalid timezone — bucketed in UTC
}

/** The civil day ("YYYY-MM-DD") and hour (0–23) of an instant in an IANA timezone. Returns null
 *  when the timezone is missing/invalid so the caller can fall back to UTC. Uses Intl (same
 *  mechanism as dayOfWeekInTimezone) — no external tz table. */
export function localDayHourInTimezone(date: Date, timezone: string): { day: string; hour: number } | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hourRaw = get("hour");
    if (!year || !month || !day || hourRaw === undefined) return null;
    let hour = Number(hourRaw);
    if (hour === 24) hour = 0; // some environments emit "24" for midnight
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    return { day: `${year}-${month}-${day}`, hour };
  } catch {
    return null; // RangeError on an invalid timeZone
  }
}

/** Sparse date×hour cells with per-slot totals + a top-8 per-campaign breakdown. Each call is
 *  bucketed in ITS campaign's local time (timezone); calls whose campaign has no/invalid timezone
 *  fall back to UTC and are counted in utcFallbackCalls so the UI can disclose the mix (loud, not silent). */
export function computeHeatmap(calls: DashCallRow[], campaigns: DashCampaignRow[]): HeatmapResult {
  const index = buildCampaignIndex(campaigns);
  interface Agg {
    day: string;
    hour: number;
    calls: number;
    connected: number;
    voicemailConnected: number;
    successful: number;
    byCampaign: Map<string, { calls: number; connected: number; voicemailConnected: number; successful: number }>;
  }
  const cells = new Map<string, Agg>();
  let localizedCalls = 0;
  let utcFallbackCalls = 0;
  for (const c of calls) {
    if (!c.created_at) continue;
    const t = Date.parse(c.created_at);
    if (!Number.isFinite(t)) continue;
    const tz = index.get(c.campaign_id)?.timezone ?? null;
    const local = tz ? localDayHourInTimezone(new Date(t), tz) : null;
    let day: string;
    let hour: number;
    if (local) {
      day = local.day;
      hour = local.hour;
      localizedCalls++;
    } else {
      day = utcDayString(t);
      hour = new Date(t).getUTCHours();
      utcFallbackCalls++;
    }
    const key = `${day}|${hour}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { day, hour, calls: 0, connected: 0, voicemailConnected: 0, successful: 0, byCampaign: new Map() };
      cells.set(key, cell);
    }
    const conn = isConnected(c.status);
    const vm = conn && c.voicemail === true && c.goal_reached !== true; // voicemail — unless the call reached the goal (goal overrides, Val 2026-07-03)
    const succ = c.goal_reached === true;
    cell.calls++;
    if (conn) cell.connected++;
    if (vm) cell.voicemailConnected++;
    if (succ) cell.successful++;
    let bc = cell.byCampaign.get(c.campaign_id);
    if (!bc) {
      bc = { calls: 0, connected: 0, voicemailConnected: 0, successful: 0 };
      cell.byCampaign.set(c.campaign_id, bc);
    }
    bc.calls++;
    if (conn) bc.connected++;
    if (vm) bc.voicemailConnected++;
    if (succ) bc.successful++;
  }
  const out: HeatCell[] = [];
  for (const cell of cells.values()) {
    const breakdown: HeatBreakdown[] = [...cell.byCampaign.entries()]
      .map(([id, v]) => ({ name: index.get(id)?.name ?? id, calls: v.calls, connected: v.connected, voicemailConnected: v.voicemailConnected, successful: v.successful }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8);
    out.push({ day: cell.day, hour: cell.hour, calls: cell.calls, connected: cell.connected, voicemailConnected: cell.voicemailConnected, successful: cell.successful, breakdown });
  }
  return { cells: out, localizedCalls, utcFallbackCalls };
}

// ── Campaign Performance table rows ──────────────────────────────────────────
export interface CampaignTableRow {
  id: string;
  name: string;
  country: string;
  cioWorkspace: string | null; // brand label (VOZ-216) — raw workspace; UI renders via brandLabel()
  displayStatus: DisplayStatus;
  scheduleType: "fixed" | "recurring";
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  // Script/segment identity for the section filters + mass export (Val 2026-08-07).
  scriptId: string | null;
  scriptName: string | null;
  segmentId: string | null;
  calls: number;
  connected: number;
  terminal: number;
  successful: number;
  connectRate: number | null;
  successRate: number | null;
  players: number; // campaign roster size (campaign_numbers_v2 count) — lifetime, NOT windowed
  reach: number; // human-only connects in window = connected − voicemailConnected
  smsSent: number; // texts sent|delivered for this campaign (== perf.sms.total over the lifetime window)
  startAt: string | null;
  endAt: string | null;
  lastCallAt: string | null;
  perf: TodayPerfDay; // per-campaign LIFETIME breakdown (lean) for the camp-row columns (Slice C)
}

/** All live (non-ghost, non-test) campaigns as table rows — INCLUDING zero-call ones
 *  (so paused/ended campaigns still appear). `calls` must already be windowed by the
 *  caller; `nowMs` injected. displayStatus uses the windowed last-call (accurate while
 *  the window ≥ idleDays, which the default 30d table window satisfies). */
export function computeCampaignTable(
  calls: DashCallRow[],
  campaigns: DashCampaignRow[],
  nowMs: number,
  idleDays = FINISHED_IDLE_DAYS,
  numbers: Array<{ campaign_id: string; id?: string; outcome?: string | null }> = [],
  sms: DashSmsRow[] = [],
): CampaignTableRow[] {
  const index = buildCampaignIndex(campaigns);
  const rollupMap = new Map(computeCampaignRollups(calls, index).map((r) => [r.id, r]));
  // Players = full roster (lifetime; numbers are NOT windowed by the caller). SMS sent =
  // sent|delivered (the app-wide definition) — reconciles with the row's perf.sms breakdown.
  const playersByCampaign = new Map<string, number>();
  for (const n of numbers) playersByCampaign.set(n.campaign_id, (playersByCampaign.get(n.campaign_id) ?? 0) + 1);
  const smsByCampaign = smsSentByCampaign(sms);
  // Declined contacts (campaign_numbers_v2.outcome === 'declined_offer') for the per-campaign Reached split.
  const declinedIds = new Set(numbers.filter((n) => (n.outcome ?? "") === "declined_offer" && n.id).map((n) => n.id as string));
  // Group calls + sms by campaign once (O(n)) so each row's lifetime breakdown is a Map lookup, not a scan.
  const callsByCampaign = new Map<string, DashCallRow[]>();
  for (const c of calls) { const g = callsByCampaign.get(c.campaign_id); if (g) g.push(c); else callsByCampaign.set(c.campaign_id, [c]); }
  const smsRowsByCampaign = new Map<string, DashSmsRow[]>();
  for (const m of sms) { const g = smsRowsByCampaign.get(m.campaign_id); if (g) g.push(m); else smsRowsByCampaign.set(m.campaign_id, [m]); }
  return campaigns
    .filter((c) => c.source !== "ghost_portal" && c.is_test !== true)
    .map((c) => {
      const r = rollupMap.get(c.id);
      const lastCallMs = r?.lastCallAtMs ?? null;
      return {
        id: c.id,
        name: c.name,
        country: parseCountryToken(c.name),
        cioWorkspace: c.cio_workspace ?? null,
        displayStatus: deriveDisplayStatus({
          rawStatus: c.status ?? null,
          endAtMs: c.end_at ? Date.parse(c.end_at) : null,
          lastCallMs,
          nowMs,
          idleDays,
          isRecurringParent: c.campaign_type === "recurring",
        }),
        scheduleType: c.campaign_type === "recurring" ? "recurring" : "fixed",
        voiceId: c.voice_id ?? null,
        agentLabel: c.vapi_assistant_name ?? null,
        baseAssistantId: c.base_assistant_id ?? null,
        scriptId: c.script_id ?? null,
        scriptName: c.script_name ?? null,
        segmentId: c.segment_id ?? null,
        calls: r?.calls ?? 0,
        connected: r?.connected ?? 0,
        terminal: r?.terminal ?? 0,
        successful: r?.successful ?? 0,
        connectRate: r?.connectRate ?? null,
        successRate: r?.successRate ?? null,
        players: playersByCampaign.get(c.id) ?? 0,
        reach: r?.reach ?? 0,
        smsSent: smsByCampaign.get(c.id) ?? 0,
        startAt: (c.start_at ?? c.created_at) ?? null,
        endAt: c.end_at ?? null,
        lastCallAt: lastCallMs ? new Date(lastCallMs).toISOString() : null,
        perf: computeWindowPerf(
          callsByCampaign.get(c.id) ?? [],
          smsRowsByCampaign.get(c.id) ?? [],
          declinedIds,
          0,
          nowMs,
          { useTranscript: false },
        ),
      };
    });
}

// ── SQL-rollup path (VOZ-283) ─────────────────────────────────────────────────
// Row shapes returned by the dashboard_call_rollup / dashboard_sms_rollup RPCs
// (2026-08-04_dashboard_rollup_rpc.sql, repo root — the tracked, as-applied
// DDL). One row per (campaign_id, day_utc); the assembler sums per campaign.

export interface CallRollupRow {
  campaign_id: string;
  day_utc: string;
  attempts: number;
  terminal: number;
  connected: number;
  voicemail: number;
  reach: number;
  positive: number;
  declined: number;
  early_hangup_lean: number;
  neutral_lean: number;
  /** goal_reached IS TRUE with NO connected gate — mirrors accumulate()'s
   *  unconditional count (a goal on a failed-status call still counts). The
   *  connected-gated `positive` above feeds the perf reached-split instead. */
  successful: number;
  /** Connected calls with a NON-NULL voicemail flag — the voicemailRate
   *  denominator (accumulate(): NULL = not evaluated, excluded). */
  voicemail_evaluated: number;
  last_call_at: string | null;
}

export interface SmsRollupRow {
  campaign_id: string;
  day_utc: string;
  sent: number;
  reached: number;
  voicemail: number;
  unreachable: number;
  positive: number;
  neutral: number;
  declined: number;
}

/**
 * Rollup-sourced twin of computeCampaignTable: SAME CampaignTableRow output,
 * numbers sourced from the SQL rollups instead of raw calls_v2/sms rows.
 * Row assembly (display status, labels, country parsing) is mirrored verbatim;
 * the perf block reuses assembleWindowPerf — the exact code body the raw path
 * uses — so the 3-card math cannot drift. Byte-parity is enforced by
 * dashboardRollup.parity.test.ts before any route cutover.
 */
export function computeCampaignTableFromRollup(
  callRollup: CallRollupRow[],
  smsRollup: SmsRollupRow[],
  campaigns: DashCampaignRow[],
  nowMs: number,
  idleDays = FINISHED_IDLE_DAYS,
  playersByCampaign: Map<string, number> = new Map(),
): CampaignTableRow[] {
  // Per-campaign sums over the day-grain rollup rows.
  interface CallAgg {
    attempts: number; terminal: number; connected: number; voicemail: number; reach: number;
    positive: number; declined: number; earlyHangup: number; neutral: number; successful: number;
    lastCallMs: number | null;
  }
  const callAgg = new Map<string, CallAgg>();
  for (const r of callRollup) {
    let a = callAgg.get(r.campaign_id);
    if (!a) {
      a = { attempts: 0, terminal: 0, connected: 0, voicemail: 0, reach: 0, positive: 0, declined: 0, earlyHangup: 0, neutral: 0, successful: 0, lastCallMs: null };
      callAgg.set(r.campaign_id, a);
    }
    a.attempts += r.attempts;
    a.terminal += r.terminal;
    a.connected += r.connected;
    a.voicemail += r.voicemail;
    a.reach += r.reach;
    a.positive += r.positive;
    a.declined += r.declined;
    a.earlyHangup += r.early_hangup_lean;
    a.neutral += r.neutral_lean;
    a.successful += r.successful;
    const t = r.last_call_at ? Date.parse(r.last_call_at) : NaN;
    if (Number.isFinite(t) && (a.lastCallMs === null || t > a.lastCallMs)) a.lastCallMs = t;
  }
  const smsAgg = new Map<string, SmsBreakdown>();
  for (const r of smsRollup) {
    let s = smsAgg.get(r.campaign_id);
    if (!s) {
      // silentPickup stays 0 on the rollup path: the SQL rollup has no turn counts
      // (same lean limitation as early_hangup_lean; the rollup DDL needs a
      // silent_pickup column before any cutover — see VOZ-283 parity gate).
      s = { total: 0, reached: 0, voicemail: 0, silentPickup: 0, unreachable: 0, positive: 0, neutral: 0, declined: 0, earlyHangup: 0, agentTimeout: 0 };
      smsAgg.set(r.campaign_id, s);
    }
    s.total += r.sent;
    s.reached += r.reached;
    s.voicemail += r.voicemail;
    s.unreachable += r.unreachable;
    s.positive += r.positive;
    s.neutral += r.neutral;
    s.declined += r.declined;
    // Lean SQL rollup can't split early-hangup vs agent-timeout texts — the
    // named remainder lands in earlyHangup so the partition still sums to
    // reached (same VOZ-283 note as smsBreakdownFromRollup).
    s.earlyHangup = Math.max(0, s.reached - s.positive - s.neutral - s.declined);
  }

  const emptySms: SmsBreakdown = { total: 0, reached: 0, voicemail: 0, silentPickup: 0, unreachable: 0, positive: 0, neutral: 0, declined: 0, earlyHangup: 0, agentTimeout: 0 };
  return campaigns
    .filter((c) => c.source !== "ghost_portal" && c.is_test !== true)
    .map((c) => {
      const a = callAgg.get(c.id);
      const connected = a?.connected ?? 0;
      const terminal = a?.terminal ?? 0;
      // Row `successful` = ungated goal count (mirrors accumulate()); the perf
      // reached-split uses the connected-gated `positive` bucket — they differ
      // on the rare goal-on-non-connected rows (5 in prod as of 08-04).
      const successful = a?.successful ?? 0;
      const lastCallMs = a?.lastCallMs ?? null;
      const cb: CallBreakdown = {
        total: a?.attempts ?? 0,
        terminal,
        connected,
        inFlight: (a?.attempts ?? 0) - terminal,
        reach: a?.reach ?? 0,
        voicemail: a?.voicemail ?? 0,
        silentPickup: 0, // rollup rows have no turn counts (see callBreakdownFromRollup note)
        unreachable: terminal - connected,
        positive: a?.positive ?? 0,
        neutral: a?.neutral ?? 0,
        declined: a?.declined ?? 0,
        earlyHangup: a?.earlyHangup ?? 0,
        agentTimeout: 0, // rollup rows predate the agent_timeout tag (see callBreakdownFromRollup note)
      };
      const sb = smsAgg.get(c.id) ?? emptySms;
      return {
        id: c.id,
        name: c.name,
        country: parseCountryToken(c.name),
        cioWorkspace: c.cio_workspace ?? null,
        displayStatus: deriveDisplayStatus({
          rawStatus: c.status ?? null,
          endAtMs: c.end_at ? Date.parse(c.end_at) : null,
          lastCallMs,
          nowMs,
          idleDays,
          isRecurringParent: c.campaign_type === "recurring",
        }),
        scheduleType: c.campaign_type === "recurring" ? ("recurring" as const) : ("fixed" as const),
        voiceId: c.voice_id ?? null,
        agentLabel: c.vapi_assistant_name ?? null,
        baseAssistantId: c.base_assistant_id ?? null,
        scriptId: c.script_id ?? null,
        scriptName: c.script_name ?? null,
        segmentId: c.segment_id ?? null,
        calls: a?.attempts ?? 0,
        connected,
        terminal,
        successful,
        connectRate: safeDiv(connected, terminal),
        successRate: safeDiv(successful, connected),
        players: playersByCampaign.get(c.id) ?? 0,
        reach: a?.reach ?? 0,
        smsSent: sb.total,
        startAt: (c.start_at ?? c.created_at) ?? null,
        endAt: c.end_at ?? null,
        lastCallAt: lastCallMs ? new Date(lastCallMs).toISOString() : null,
        perf: assembleWindowPerf(cb, sb),
      };
    });
}

// ── Call records (per campaign_number, for the expandable row) ───────────────
export interface DashNumberRow {
  id: string;
  phone_e164?: string | null;
  outcome?: string | null;
}

// Val's 7 record statuses. NOTE: 'voicemail' and 'wrong_number' are currently
// underivable (voicemail isn't persisted; wrong_number is a dead bucket) — they
// stay at 0 until the voicemail-persistence slice. The rest derive from outcome.
export type RecordStatus =
  | "successful"
  | "offer_delivered"
  | "not_interested"
  | "awaiting_retry"
  | "voicemail"
  | "unreached"
  | "wrong_number";

export function deriveRecordStatus(outcome: string | null, anyGoal: boolean): RecordStatus {
  if (anyGoal) return "successful"; // a goal on any attempt wins
  switch ((outcome ?? "").toLowerCase()) {
    case "sent_sms":
    case "sms_delivered": // offer SMS sent/delivered (registered_optin voicemail follow-up) — retired from retries
      // Split from "successful" (Val 2026-07-03, ticket 1216090162016320): a delivered offer SMS is a
      // WIN but NOT a human "Positive response" — the contact may never have engaged (voicemail → auto
      // follow-up). Only a goal (handled above) reads "Positive response"; delivery reads "Offer delivered".
      return "offer_delivered";
    case "not_interested":
    case "declined_offer":
      return "not_interested";
    case "pending_retry":
    case "pending":
    case "in_progress":
      return "awaiting_retry";
    case "wrong_number":
      return "wrong_number";
    case "unreached":
    case "suppressed":
    case "removed_from_segment":
    case "recently_called_elsewhere":
      return "unreached";
    default:
      return "unreached";
  }
}

// ── Per-attempt + contact outcome tagging (Campaign Performance Phase 2) ─────
// SHARED CONTRACT — every Phase-2 piece imports these verbatim. Per-attempt rules
// mirror campaignAnalytics.computeOne's outcomeBreakdown (+ ANALYTICS_CONFIG.EARLY_HANGUP_SEC);
// the contact tag is the funnel-furthest attempt tag (positive > declined > neutral >
// early_hangup > voicemail > unreachable), or an outcome-derived tag when there are no calls.
export type AttemptTag = "unreachable" | "voicemail" | "positive" | "declined" | "agent_timeout" | "early_hangup" | "silent_pickup" | "neutral";
export type ContactTag = AttemptTag | "awaiting_retry" | "wrong_number";

export interface CallAttempt {
  index: number; // 1-based attempt number (created_at asc)
  tag: AttemptTag;
  atMs: number | null;
}

export interface CallRecord {
  campaignNumberId: string;
  phone: string | null;
  status: RecordStatus; // contact DISPOSITION (lifecycle) — drives the Status column + status filter
  tag: ContactTag; // contact-level overall OUTCOME (drives the outcome filter + export)
  attempts: CallAttempt[]; // ordered by created_at asc; attempt 1 first
  lastAttemptedMs: number | null;
  smsSent?: boolean; // contact was sent an SMS in this campaign (route-supplied) — drives the "SMS sent" slice
}

export const ATTEMPT_TAG_LABELS: Record<ContactTag, string> = {
  unreachable: "Unreachable",
  voicemail: "Voicemail detected",
  positive: "Positive response",
  declined: "Declined",
  agent_timeout: "Agent timeout",
  early_hangup: "Early hangup",
  silent_pickup: "Silent pickup",
  neutral: "Neutral",
  awaiting_retry: "Awaiting retry",
  wrong_number: "Wrong number",
};

// Honest, plain-English definitions for each tag — surfaced as hover tooltips on the records
// outcome chips. These are PROXY classifications (best-effort, derived from call data), not
// verified labels; the wording discloses that without renaming the categories. Mirrors the
// "Estimated" hint treatment on the records filters + breakdown-row "est" chips.
export const ATTEMPT_TAG_DESC: Record<ContactTag, string> = {
  positive: "Agreed to receive the offer SMS (goal reached) — not a confirmed sale.",
  neutral: "Connected to a person, but no clear positive or negative outcome was detected.",
  declined: "Contact declined the offer — applied to the whole contact, so it can show on earlier attempts too.",
  agent_timeout: "Reached a person, but the agent failed to respond (AI pipeline error/timeout) — a missed live pickup.",
  early_hangup: "Connected but ended with little or no real conversation — a quick hangup or no engagement.",
  silent_pickup:
    "The line answered but nobody ever spoke — dead air, a pocket answer, or an undetected machine. " +
    "Not counted as a reached human (2026-08-13: was 158 of 338 'reached' on a measured day).",
  voicemail: "Best-effort automated voicemail detection; may misclassify.",
  unreachable: "Call didn't connect (no answer, busy, or failed).",
  awaiting_retry: "Not yet resolved — still scheduled for another attempt.",
  wrong_number: "Marked as a wrong or invalid number.",
};

// Semantic palette (pattern brief §2) — the SAME meaning-hues as ROW_COLOR so a tag reads
// identically in chips, dots, and segments. awaiting_retry/wrong_number stay neutral greys.
export const ATTEMPT_TAG_COLOR: Record<ContactTag, string> = {
  positive: "#3ec08a",
  neutral: "#5b9bf0",
  declined: "#e46664",
  agent_timeout: "#c264d6",
  early_hangup: "#e0814a",
  silent_pickup: "#a8814f", // muted ochre — "unknown pickup", between early-hangup orange and the greys
  voicemail: "#8f86e6",
  unreachable: "#e0a53c",
  awaiting_retry: "#7d828c",
  wrong_number: "#565b64",
};

// Contact-tag priority: funnel-furthest among a contact's attempt tags wins.
// silent_pickup sits ABOVE voicemail (an unknown pickup carries more signal than a
// detected machine) and BELOW every human tag (2026-08-13, Phase A).
const CONTACT_TAG_PRIORITY: AttemptTag[] = ["positive", "declined", "neutral", "early_hangup", "agent_timeout", "silent_pickup", "voicemail", "unreachable"];

/** calls_v2.transcript is jsonb `{ text }` from the DB, but a plain string in unit tests. */
function transcriptText(t: DashCallRow["transcript"]): string {
  if (!t) return "";
  return typeof t === "string" ? t : (t.text ?? "");
}

/** Endings that mean the call was deliberately ENDED (by either side) — the bail rule
 *  below only fires on these, so a pipeline-death or unknown ending never silently
 *  reads as "the customer hung up". assistant-* endings joined 2026-08-13 (Phase A):
 *  when the agent recognises a dud pickup and says "Goodbye", ended_reason is
 *  assistant-ended-call — the customer-ended-only rule tagged those 'neutral', which
 *  is a TEXTABLE bucket under optin_reached_only. */
const BAIL_ENDINGS = new Set([
  "customer-ended-call",
  "assistant-ended-call",
  "assistant-said-end-call-phrase",
  "assistant-ended-call-after-message-spoken",
]);

/** Definitive "no real conversation" signal for a connected, non-voicemail, non-goal call.
 *  Engagement (2026-06-26): a connected call where no real conversation happened is an early
 *  hangup, not "neutral". Duration alone misses bails (a 30s clock with one "Hello?").
 *
 *  v2 (2026-08-13, Phase A replay over 8,140 prod calls): callers now route ZERO-turn calls
 *  to `silent_pickup` BEFORE this check, so this function decides bails for calls with at
 *  least one real utterance:
 *    - silence-timed-out: spoke, then went silent — early hangup (unchanged).
 *    - a BAIL_ENDINGS end with <=1 substantive turn — early hangup, regardless of duration
 *      (June's rule, extended to agent-ended goodbyes).
 *    - duration < EARLY_HANGUP_SEC only counts with <=1 turn: a rapid multi-turn exchange
 *      is a real conversation, not a hang-up (was: any short call).
 *  `opts.useTranscript:false` (lean/ranged path, spec §5.1) keeps the ORIGINAL lean rules
 *  verbatim (silence-timed-out OR bare duration) — it cannot count turns, and passing
 *  transcript:null is NOT equivalent (userTurns=0 would make it over-fire). */
export function isEarlyHangup(call: DashCallRow, opts: { useTranscript?: boolean } = {}): boolean {
  const useTranscript = opts.useTranscript !== false;
  if (call.ended_reason === "silence-timed-out") return true; // connected, then silence
  if (!useTranscript) {
    // lean path: unchanged pre-v2 behaviour (no transcript available to do better)
    return typeof call.duration_seconds === "number" && call.duration_seconds < ANALYTICS_CONFIG.EARLY_HANGUP_SEC;
  }
  const turns = substantiveUserTurnCount(transcriptText(call.transcript));
  if (turns > 1) return false; // real back-and-forth — never a bail, however short
  if (BAIL_ENDINGS.has(call.ended_reason ?? "")) return true; // pickup-and-bail
  if (typeof call.duration_seconds === "number" && call.duration_seconds < ANALYTICS_CONFIG.EARLY_HANGUP_SEC)
    return true; // short one-utterance call with an ambiguous ending
  return false;
}

/** Per-attempt outcome tag for a single call. `declinedContact` = the call's CONTACT has
 *  campaign_numbers_v2.outcome === 'declined_offer'. Mirrors campaignAnalytics' priority
 *  (voicemail===null is NOT voicemail — treated as a human). `opts.useTranscript:false` selects the
 *  lean (transcript-less) early-hangup rule for the ranged dashboard path (spec §5.1). */
export function deriveAttemptTag(
  call: DashCallRow,
  declinedContact: boolean,
  opts: { useTranscript?: boolean } = {},
): AttemptTag {
  // goal_reached wins over BOTH connection status and the voicemail flag (Val 2026-07-03 / 07-06): a
  // call that reached the goal reads Positive, so a contact's "Positive response" STATUS always has a
  // matching positive attempt. anyGoal (computeCallRecords) counts a goal regardless of connection, so
  // this ordering keeps STATUS and its attempts consistent. Prod residual: 4 records had goal_reached on
  // a status=failed call (3/4 with a real-conversation ended_reason) — previously mis-tagged unreachable.
  if (call.goal_reached === true) return "positive";
  if (!isConnected(call.status)) return "unreachable";
  if (call.voicemail === true) return "voicemail";
  // Agent timeout = reached a human but the AI pipeline failed to respond (e.g. OpenAI
  // quota death). Its own category under Reached, ahead of early_hangup (a 3s 429 call
  // would otherwise read as a duration-based early hangup).
  if (isAgentTimeout(call.ended_reason)) return "agent_timeout";
  // silent_pickup (2026-08-13, Phase A over 8,140 prod calls): the line answered but
  // NOBODY EVER SPOKE — zero substantive user turns, which includes a transcript that
  // was never captured. Zero human evidence is not "reached": on a measured day 158 of
  // 338 "reached" calls were dead air, and 316 zero-turn calls across the window read
  // 'neutral' (a TEXTABLE bucket) because an agent-ended call dodged every early-hangup
  // branch. Sits ABOVE declined on purpose — a call with no human on it must not
  // inherit the contact's decline (declined is also textable under optin_reached_only).
  // The lean path can't count turns and therefore never emits this tag (spec §5.1 —
  // same EST divergence as the lean early-hangup rule).
  if (opts.useTranscript !== false && substantiveUserTurnCount(transcriptText(call.transcript)) === 0)
    return "silent_pickup";
  if (declinedContact) return "declined";
  return isEarlyHangup(call, opts) ? "early_hangup" : "neutral";
}

/** One record per campaign_number: ordered per-attempt tags + a contact-level tag + last-attempt
 *  time. `calls` should be that campaign's calls. Numbers with no calls still produce a record. */
export function computeCallRecords(numbers: DashNumberRow[], calls: DashCallRow[], opts: { useTranscript?: boolean } = {}): CallRecord[] {
  // Contacts whose outcome is an explicit decline (drives the per-attempt 'declined' tag).
  const declinedContactIds = new Set(
    numbers.filter((n) => (n.outcome ?? "") === "declined_offer").map((n) => n.id),
  );

  // Group calls by campaign_number_id.
  const callsByNumber = new Map<string, DashCallRow[]>();
  for (const c of calls) {
    const id = c.campaign_number_id ?? "";
    if (!id) continue;
    let group = callsByNumber.get(id);
    if (!group) {
      group = [];
      callsByNumber.set(id, group);
    }
    group.push(c);
  }

  return numbers.map((n) => {
    const group = callsByNumber.get(n.id) ?? [];
    const declined = declinedContactIds.has(n.id);
    const anyGoal = group.some((c) => c.goal_reached === true);
    // Sort by created_at asc (attempt 1 first); unparseable dates sort last (stable).
    const sorted = [...group].sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : NaN;
      const tb = b.created_at ? Date.parse(b.created_at) : NaN;
      const va = Number.isFinite(ta) ? ta : Infinity;
      const vb = Number.isFinite(tb) ? tb : Infinity;
      return va - vb;
    });
    const attempts: CallAttempt[] = sorted.map((c, i) => {
      const t = c.created_at ? Date.parse(c.created_at) : NaN;
      return { index: i + 1, tag: deriveAttemptTag(c, declined, opts), atMs: Number.isFinite(t) ? t : null };
    });
    let lastAttemptedMs: number | null = null;
    for (const a of attempts) {
      if (a.atMs !== null && (lastAttemptedMs === null || a.atMs > lastAttemptedMs)) lastAttemptedMs = a.atMs;
    }

    // Contact tag: funnel-furthest attempt tag; else derive from outcome when no calls.
    let tag: ContactTag;
    if (attempts.length === 0) {
      const outcome = (n.outcome ?? "").toLowerCase();
      if (outcome === "wrong_number") tag = "wrong_number";
      else if (outcome === "pending" || outcome === "pending_retry" || outcome === "") tag = "awaiting_retry";
      else tag = "unreachable";
    } else {
      const present = new Set(attempts.map((a) => a.tag));
      tag = CONTACT_TAG_PRIORITY.find((p) => present.has(p)) ?? "unreachable";
    }

    return {
      campaignNumberId: n.id,
      phone: n.phone_e164 ?? null,
      status: deriveRecordStatus(n.outcome ?? null, anyGoal),
      tag,
      attempts,
      lastAttemptedMs,
    };
  });
}

/** True when ANY of the contact's attempts carries `tag`. Backs the records "Attempt outcome"
 *  filter — a per-attempt axis distinct from the contact DISPOSITION (status) filter. A contact
 *  with no attempts matches no attempt outcome. Pure; no classification logic here. */
export function recordHasAttemptOutcome(record: CallRecord, tag: AttemptTag): boolean {
  return record.attempts.some((a) => a.tag === tag);
}

/** Attempt tags that mean a live human conversation happened (the inverse of voicemail/unreachable).
 *  Backs the "Reached" drill-down group on the Today cards. */
export const HUMAN_TAGS: ReadonlySet<AttemptTag> = new Set<AttemptTag>(["positive", "neutral", "declined", "early_hangup", "agent_timeout"]);

/** True when the contact was reached by a live human on ANY attempt — the records-side counterpart
 *  of the Reached card metric. Pure; no classification logic here. */
export function recordIsReached(record: CallRecord): boolean {
  return record.attempts.some((a) => HUMAN_TAGS.has(a.tag));
}

/** A day-scoped record + whether the contact got a sent|delivered SMS that day — lets the Today
 *  SMS card drill into texted contacts. Returned by /api/dashboard/today/records. */
export type TodayCallRecord = CallRecord & { smsSentToday: boolean };

/** Attach `smsSentToday` (campaignNumberId ∈ the day's sent/delivered SMS set) to each record. Pure. */
export function attachSmsSent(records: CallRecord[], sentNumberIds: Set<string>): TodayCallRecord[] {
  return records.map((r) => ({ ...r, smsSentToday: sentNumberIds.has(r.campaignNumberId) }));
}

// ── Today's Performance card breakdowns (per-window partitions) ──────────────
// Powers the 3-card Today's Performance redesign (Val's mockup, 2026-06-29). The Reached
// split is a PROXY that mirrors campaignAnalytics.outcomeBreakdown EXACTLY (same priority,
// same EARLY_HANGUP_SEC), so the cards reconcile with the records drawer. "estimated" in UI.
export interface CallBreakdown {
  total: number; // all attempts in the window
  terminal: number; // connected + terminal-nonconnect (excludes in-flight)
  connected: number; // CONNECTED_STATUSES (incl. voicemail)
  inFlight: number; // total − terminal (still dialing/ringing)
  reach: number; // connected − voicemail − silentPickup (live humans)
  voicemail: number; // connected & voicemail===true
  /** 2026-08-13 (Phase A): connected, but zero substantive user turns — dead air,
   *  pocket answer, or an undetected machine. Deliberately OUTSIDE `reach`, which
   *  changes the reach denominator (and every rate on it) for history too, since
   *  tags compute at read time. Partition: connected = reach + voicemail + silentPickup. */
  silentPickup: number;
  unreachable: number; // terminal − connected
  // Reached split — partitions `reach` (sums to reach).
  positive: number;
  neutral: number;
  declined: number;
  earlyHangup: number;
  /** VOZ-330 tag on the card too (2026-08-07): deriveAttemptTag gained
   *  agent_timeout but this breakdown didn't, so the Reached card disagreed
   *  with the records drawer for pipeline-death calls. Mirrors the tag. */
  agentTimeout: number;
}

/** Partition calls with created_at in [startMs, endMs) into the Call-Attempts + Reached card
 *  rows. `declinedIds` = campaign_number_ids whose contact outcome is 'declined_offer'. */
export function callWindowBreakdown(
  calls: DashCallRow[],
  declinedIds: Set<string>,
  startMs: number,
  endMs: number,
  opts: { useTranscript?: boolean } = {},
): CallBreakdown {
  const b: CallBreakdown = {
    total: 0, terminal: 0, connected: 0, inFlight: 0, reach: 0, voicemail: 0, silentPickup: 0, unreachable: 0,
    positive: 0, neutral: 0, declined: 0, earlyHangup: 0, agentTimeout: 0,
  };
  for (const c of calls) {
    const t = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    b.total += 1;
    if (isTerminal(c.status)) b.terminal += 1;
    if (!isConnected(c.status)) continue;
    b.connected += 1;
    if (c.voicemail === true && c.goal_reached !== true) { b.voicemail += 1; continue; } // goal_reached overrides voicemail (Val 2026-07-03)
    // Outcome split — mirrors deriveAttemptTag priority verbatim (the shared seam).
    if (c.goal_reached === true) { b.reach += 1; b.positive += 1; continue; }
    if (isAgentTimeout(c.ended_reason)) { b.reach += 1; b.agentTimeout += 1; continue; } // ahead of declined/early — same slot as deriveAttemptTag
    // silent_pickup (2026-08-13): zero substantive turns → NOT a reached human. Same
    // slot as deriveAttemptTag (above declined). Lean path can't count turns → skips.
    if (opts.useTranscript !== false && substantiveUserTurnCount(transcriptText(c.transcript)) === 0) {
      b.silentPickup += 1;
      continue;
    }
    b.reach += 1;
    if (c.campaign_number_id && declinedIds.has(c.campaign_number_id)) { b.declined += 1; continue; }
    if (isEarlyHangup(c, opts)) b.earlyHangup += 1; else b.neutral += 1;
  }
  b.unreachable = b.terminal - b.connected;
  b.inFlight = b.total - b.terminal;
  return b;
}

export interface SmsBreakdown {
  total: number; // sent|delivered SMS in the window
  reached: number; // SMS to a reached human (positive|neutral|declined|early_hangup|agent_timeout)
  voicemail: number; // SMS to a voicemail pickup (registered_optin follow-up)
  /** SMS whose call had zero substantive user turns (2026-08-13). optin_reached_only
   *  refuses this bucket at dispatch, so a non-zero count here is either an older
   *  consent mode or a leak worth investigating — that visibility is the point. */
  silentPickup: number;
  unreachable: number; // SMS whose call didn't connect
  // by-response of the reached SMS. Every reached text is NAMED — the partition
  // positive+neutral+declined+earlyHangup+agentTimeout === reached. early_hangup
  // used to hide inside `reached` with no sub-row, which is exactly how Val found
  // texted players under the Early hang-up filter that the SMS card never showed
  // (2026-08-07: Reached 12, sub-rows summed to 2).
  positive: number;
  neutral: number;
  declined: number;
  earlyHangup: number;
  agentTimeout: number;
}

/** Bucket each sent|delivered SMS (created_at in [startMs, endMs)) by its recipient call's
 *  outcome, joining sms.call_id → calls_v2.id. SMS with no matching call count in `total` only
 *  (honest — we can't attribute an outcome). Reuses deriveAttemptTag (single source of truth). */
export function smsWindowBreakdown(
  sms: DashSmsRow[],
  calls: DashCallRow[],
  declinedIds: Set<string>,
  startMs: number,
  endMs: number,
  opts: { useTranscript?: boolean } = {},
): SmsBreakdown {
  const callById = new Map<string, DashCallRow>();
  for (const c of calls) if (c.id) callById.set(c.id, c);
  const b: SmsBreakdown = { total: 0, reached: 0, voicemail: 0, silentPickup: 0, unreachable: 0, positive: 0, neutral: 0, declined: 0, earlyHangup: 0, agentTimeout: 0 };
  for (const m of sms) {
    if (!isSmsSent(m.status)) continue;
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    b.total += 1;
    const call = m.call_id ? callById.get(m.call_id) : undefined;
    if (!call) continue; // unmatched → counted in total only
    const tag = deriveAttemptTag(call, !!(call.campaign_number_id && declinedIds.has(call.campaign_number_id)), opts);
    if (tag === "voicemail") { b.voicemail += 1; continue; }
    if (tag === "silent_pickup") { b.silentPickup += 1; continue; } // never "reached" (2026-08-13)
    if (tag === "unreachable") { b.unreachable += 1; continue; }
    b.reached += 1; // positive | neutral | declined | early_hangup | agent_timeout
    if (tag === "positive") b.positive += 1;
    else if (tag === "neutral") b.neutral += 1;
    else if (tag === "declined") b.declined += 1;
    else if (tag === "early_hangup") b.earlyHangup += 1;
    else if (tag === "agent_timeout") b.agentTimeout += 1;
  }
  return b;
}

/** Fractional change of a TOTAL vs a baseline (0.166 ⇒ +16.6%). null when there's no baseline. */
export function pctDelta(today: number, base: number | null): number | null {
  if (base === null || base === 0) return null;
  return (today - base) / base;
}

/** Percentage-POINT change of a RATE vs a baseline rate (-0.012 ⇒ -1.2pp). null when either is null. */
export function ppDelta(todayRate: number | null, baseRate: number | null): number | null {
  if (todayRate === null || baseRate === null) return null;
  return todayRate - baseRate;
}

// ── Today's Performance day assembly (3-card model) ──────────────────────────
function mkRow(
  key: string,
  label: string,
  count: number,
  denom: number,
  prevCount: number,
  prevDenom: number,
  avgCount: number,
  avgDenom: number,
  opts?: { isEstimated?: boolean; subRows?: PerfRow[] },
): PerfRow {
  const pct = safeDiv(count, denom);
  const row: PerfRow = {
    key,
    label,
    count,
    pct,
    deltaPpVsYesterday: ppDelta(pct, safeDiv(prevCount, prevDenom)),
    deltaPpVsSevenDayAvg: ppDelta(pct, safeDiv(avgCount, avgDenom)),
  };
  if (opts?.isEstimated) row.isEstimated = true;
  if (opts?.subRows) row.subRows = opts.subRows;
  return row;
}

function mkMetric(total: number, prevTotal: number, avg7Total: number, rows: PerfRow[]): PerfMetric {
  return {
    total,
    deltaPctVsYesterday: pctDelta(total, prevTotal),
    deltaPctVsSevenDayAvg: pctDelta(total, avg7Total / 7), // 7d-avg of a total = mean daily
    rows,
  };
}

/** Assemble one day's 3-card Today's Performance block (today or yesterday), with vs-prior-day
 *  and vs-7-day-avg deltas (7d rate = pooled over the prior 7 days). `liveCalls`/`liveSms` must
 *  already exclude ghost + test. Denominators per spec: Call-Attempts rows % of total; Reached
 *  rows % of reach; SMS rows % of SMS total; SMS by-response sub-rows % of SMS-reached. */
export function computeTodayPerf(
  liveCalls: DashCallRow[],
  liveSms: DashSmsRow[],
  declinedIds: Set<string>,
  dayStartMs: number,
): TodayPerfDay {
  const dEnd = dayStartMs + MS_PER_DAY;
  const cb = callWindowBreakdown(liveCalls, declinedIds, dayStartMs, dEnd);
  const sb = smsWindowBreakdown(liveSms, liveCalls, declinedIds, dayStartMs, dEnd);
  const cbP = callWindowBreakdown(liveCalls, declinedIds, dayStartMs - MS_PER_DAY, dayStartMs);
  const sbP = smsWindowBreakdown(liveSms, liveCalls, declinedIds, dayStartMs - MS_PER_DAY, dayStartMs);
  const cb7 = callWindowBreakdown(liveCalls, declinedIds, dayStartMs - 7 * MS_PER_DAY, dayStartMs);
  const sb7 = smsWindowBreakdown(liveSms, liveCalls, declinedIds, dayStartMs - 7 * MS_PER_DAY, dayStartMs);
  return assembleTodayPerf(cb, sb, cbP, sbP, cb7, sb7);
}

/** The delta-ful 3-card assembly, shared VERBATIM by the raw-rows path
 *  (computeTodayPerf) and the SQL-rollup path (computeTodayFromRollup) —
 *  one code body, so the two paths cannot drift (VOZ-283 parity). */
function assembleTodayPerf(
  cb: CallBreakdown,
  sb: SmsBreakdown,
  cbP: CallBreakdown,
  sbP: SmsBreakdown,
  cb7: CallBreakdown,
  sb7: SmsBreakdown,
): TodayPerfDay {
  const callAttempts = mkMetric(cb.total, cbP.total, cb7.total, [
    mkRow("reached", "Reached", cb.reach, cb.total, cbP.reach, cbP.total, cb7.reach, cb7.total),
    mkRow("voicemail", "Voicemail", cb.voicemail, cb.total, cbP.voicemail, cbP.total, cb7.voicemail, cb7.total),
    // 2026-08-13 (Phase A): answered but nobody spoke — deliberately OUTSIDE Reached.
    // 0 on the rollup path until its DDL gains the column (see callBreakdownFromRollup).
    mkRow("silent_pickup", "Silent pickup", cb.silentPickup, cb.total, cbP.silentPickup, cbP.total, cb7.silentPickup, cb7.total),
    mkRow("unreachable", "Unreachable", cb.unreachable, cb.total, cbP.unreachable, cbP.total, cb7.unreachable, cb7.total),
  ]);

  const est = { isEstimated: true };
  const reached = mkMetric(cb.reach, cbP.reach, cb7.reach, [
    mkRow("positive", "Positive", cb.positive, cb.reach, cbP.positive, cbP.reach, cb7.positive, cb7.reach, est),
    mkRow("neutral", "Neutral", cb.neutral, cb.reach, cbP.neutral, cbP.reach, cb7.neutral, cb7.reach, est),
    mkRow("declined", "Declined", cb.declined, cb.reach, cbP.declined, cbP.reach, cb7.declined, cb7.reach, est),
    mkRow("early_hangup", "Early hang-up", cb.earlyHangup, cb.reach, cbP.earlyHangup, cbP.reach, cb7.earlyHangup, cb7.reach, est),
    mkRow("agent_timeout", "Agent timeout", cb.agentTimeout, cb.reach, cbP.agentTimeout, cbP.reach, cb7.agentTimeout, cb7.reach, est),
  ]);

  // Every reached text named (Val 2026-08-07) — the sub-rows now PARTITION the
  // Reached count instead of silently omitting early hang-up / agent timeout.
  const smsReachedSub = [
    mkRow("positive", "Positive", sb.positive, sb.reached, sbP.positive, sbP.reached, sb7.positive, sb7.reached),
    mkRow("neutral", "Neutral", sb.neutral, sb.reached, sbP.neutral, sbP.reached, sb7.neutral, sb7.reached),
    mkRow("declined", "Declined", sb.declined, sb.reached, sbP.declined, sbP.reached, sb7.declined, sb7.reached),
    mkRow("early_hangup", "Early hang-up", sb.earlyHangup, sb.reached, sbP.earlyHangup, sbP.reached, sb7.earlyHangup, sb7.reached),
    mkRow("agent_timeout", "Agent timeout", sb.agentTimeout, sb.reached, sbP.agentTimeout, sbP.reached, sb7.agentTimeout, sb7.reached),
  ];
  const sms = mkMetric(sb.total, sbP.total, sb7.total, [
    mkRow("reached", "Reached", sb.reached, sb.total, sbP.reached, sbP.total, sb7.reached, sb7.total, { subRows: smsReachedSub }),
    mkRow("voicemail", "Voicemail", sb.voicemail, sb.total, sbP.voicemail, sbP.total, sb7.voicemail, sb7.total),
    // 2026-08-13: reached_only refuses this bucket at dispatch — non-zero here means
    // an older consent mode or a leak worth investigating (that visibility is the point).
    mkRow("silent_pickup", "Silent pickup", sb.silentPickup, sb.total, sbP.silentPickup, sbP.total, sb7.silentPickup, sb7.total),
    mkRow("unreachable", "Unreachable", sb.unreachable, sb.total, sbP.unreachable, sbP.total, sb7.unreachable, sb7.total),
  ]);

  return { callAttempts, reached, sms, inFlight: cb.inFlight };
}

// ── Ranged Performance (Global Performance 3-card — Val's mockup) ─────────────
// Same rows/denominators as computeTodayPerf but over an arbitrary [startMs,endMs) window, with
// NO deltas (the mockup's Global cards show count + pct + bar only) and the transcript-less lean
// classifier (spec §5.1 — no PII in the always-on aggregate path).
function mkRowNoDelta(
  key: string,
  label: string,
  count: number,
  denom: number,
  opts?: { isEstimated?: boolean; subRows?: PerfRow[] },
): PerfRow {
  const row: PerfRow = {
    key,
    label,
    count,
    pct: safeDiv(count, denom),
    deltaPpVsYesterday: null,
    deltaPpVsSevenDayAvg: null,
  };
  if (opts?.isEstimated) row.isEstimated = true;
  if (opts?.subRows) row.subRows = opts.subRows;
  return row;
}

function mkMetricNoDelta(total: number, rows: PerfRow[]): PerfMetric {
  return { total, deltaPctVsYesterday: null, deltaPctVsSevenDayAvg: null, rows };
}

/** Unified no-delta windowed perf core (Slice C) — assembles the 3-card breakdown (Call attempts /
 *  Reached / SMS) over [startMs,endMs) with `opts.useTranscript` (default true). Single source for the
 *  Global ranged cards (lean), the per-campaign Today rows (transcript), and the Campaign Performance
 *  rows (lean). `calls`/`sms` must already exclude ghost + test (and be campaign-scoped, where per-campaign). */
export function computeWindowPerf(
  calls: DashCallRow[],
  sms: DashSmsRow[],
  declinedIds: Set<string>,
  startMs: number,
  endMs: number,
  opts: { useTranscript?: boolean } = {},
): TodayPerfDay {
  const cb = callWindowBreakdown(calls, declinedIds, startMs, endMs, opts);
  const sb = smsWindowBreakdown(sms, calls, declinedIds, startMs, endMs, opts);
  return assembleWindowPerf(cb, sb);
}

/** The no-delta 3-card assembly, shared VERBATIM by the raw-rows path
 *  (computeWindowPerf) and the SQL-rollup path (computeCampaignTableFromRollup)
 *  — one code body, so the two paths cannot drift (VOZ-283 parity). */
function assembleWindowPerf(cb: CallBreakdown, sb: SmsBreakdown): TodayPerfDay {
  const callAttempts = mkMetricNoDelta(cb.total, [
    mkRowNoDelta("reached", "Reached", cb.reach, cb.total),
    mkRowNoDelta("voicemail", "Voicemail", cb.voicemail, cb.total),
    // 2026-08-13 (Phase A): answered but nobody spoke — outside Reached (0 on rollup path).
    mkRowNoDelta("silent_pickup", "Silent pickup", cb.silentPickup, cb.total),
    mkRowNoDelta("unreachable", "Unreachable", cb.unreachable, cb.total),
  ]);

  const est = { isEstimated: true };
  const reached = mkMetricNoDelta(cb.reach, [
    mkRowNoDelta("positive", "Positive", cb.positive, cb.reach, est),
    mkRowNoDelta("neutral", "Neutral", cb.neutral, cb.reach, est),
    mkRowNoDelta("declined", "Declined", cb.declined, cb.reach, est),
    mkRowNoDelta("early_hangup", "Early hang-up", cb.earlyHangup, cb.reach, est),
    mkRowNoDelta("agent_timeout", "Agent timeout", cb.agentTimeout, cb.reach, est),
  ]);

  // Same named partition as the Today assembly (Val 2026-08-07) — no hidden reached texts.
  const smsReachedSub = [
    mkRowNoDelta("positive", "Positive", sb.positive, sb.reached),
    mkRowNoDelta("neutral", "Neutral", sb.neutral, sb.reached),
    mkRowNoDelta("declined", "Declined", sb.declined, sb.reached),
    mkRowNoDelta("early_hangup", "Early hang-up", sb.earlyHangup, sb.reached),
    mkRowNoDelta("agent_timeout", "Agent timeout", sb.agentTimeout, sb.reached),
  ];
  const smsMetric = mkMetricNoDelta(sb.total, [
    mkRowNoDelta("reached", "Reached", sb.reached, sb.total, { subRows: smsReachedSub }),
    mkRowNoDelta("voicemail", "Voicemail", sb.voicemail, sb.total),
    mkRowNoDelta("silent_pickup", "Silent pickup", sb.silentPickup, sb.total), // 2026-08-13
    mkRowNoDelta("unreachable", "Unreachable", sb.unreachable, sb.total),
  ]);

  return { callAttempts, reached, sms: smsMetric, inFlight: cb.inFlight };
}

/** Ranged 3-card block for Global Performance — lean (transcript-less) windowed perf (spec B §5.1). */
export function computeRangedPerf(
  liveCalls: DashCallRow[],
  liveSms: DashSmsRow[],
  declinedIds: Set<string>,
  startMs: number,
  endMs: number,
): TodayPerfDay {
  return computeWindowPerf(liveCalls, liveSms, declinedIds, startMs, endMs, { useTranscript: false });
}

/** Per-entity ranged perf (Slice E): scope calls+sms to a campaign-id set, then reuse the lean ranged
 *  builder. Powers the Top Performers per-entity breakdown cards (Best Campaign/Agent/Prompt). Empty
 *  set → empty perf. Pure — caller supplies the already-filtered/in-scope call+sms sets. */
export function perfForCampaignScope(
  calls: DashCallRow[],
  sms: DashSmsRow[],
  declinedIds: Set<string>,
  startMs: number,
  endMs: number,
  campaignIds: ReadonlySet<string>,
): TodayPerfDay {
  const c = calls.filter((x) => campaignIds.has(x.campaign_id));
  const s = sms.filter((m) => campaignIds.has(m.campaign_id));
  return computeRangedPerf(c, s, declinedIds, startMs, endMs);
}

/** Per-campaign TODAY breakdown for the Today's-campaigns rows (Slice A). Transcript-based (matches the
 *  Today's Performance cards), no deltas (mockup campaign rows show none). `campaignCalls`/`campaignSms`
 *  must already be filtered to ONE campaign (ghost/test excluded). Reuses the windowed breakdown
 *  primitives + the no-delta assembly. */
export function computeCampaignTodayPerf(
  campaignCalls: DashCallRow[],
  campaignSms: DashSmsRow[],
  declinedIds: Set<string>,
  dayStartMs: number,
  dayEndMs: number,
): TodayPerfDay {
  return computeWindowPerf(campaignCalls, campaignSms, declinedIds, dayStartMs, dayEndMs); // default: transcript
}

// ── Today's Performance (NEVER filtered — always today, UTC) ─────────────────
function utcDayString(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's snapshot. Ghost always excluded; test excluded (client view). `now` injected. */
export function computeToday(
  calls: DashCallRow[],
  campaigns: DashCampaignRow[],
  sms: DashSmsRow[],
  now: number,
  numbers: DashNumberRow[] = [], // campaign_numbers_v2 (id, outcome) for the windowed call set — drives declined detection
  rosterByCampaign: Map<string, number> = new Map(), // route-supplied per-campaign roster sizes (Slice A)
): TodaySnapshot {
  const index = buildCampaignIndex(campaigns);
  const liveCampaigns = campaigns.filter((c) => c.source !== "ghost_portal" && c.is_test !== true);

  const todayStartMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const yesterdayStartMs = todayStartMs - MS_PER_DAY;
  const sevenDayStartMs = todayStartMs - 7 * MS_PER_DAY;

  // Non-ghost, non-test calls only (mirror the client-facing exclusion).
  const liveCalls = calls.filter((c) => {
    const camp = index.get(c.campaign_id);
    return camp && camp.source !== "ghost_portal" && camp.is_test !== true;
  });
  // Non-ghost, non-test SMS (mirror the call exclusion) + contacts that explicitly declined the offer.
  const liveSms = sms.filter((m) => {
    const camp = index.get(m.campaign_id);
    return camp && camp.source !== "ghost_portal" && camp.is_test !== true;
  });
  const declinedIds = new Set(numbers.filter((n) => (n.outcome ?? "") === "declined_offer").map((n) => n.id));

  let callsToday = 0;
  let callsYesterday = 0;
  let callsPrior7d = 0; // [sevenDayStart, todayStart)
  const todayRate = emptyRate();
  const todayByCampaign = new Map<string, RateRow>();

  for (const c of liveCalls) {
    const t = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t >= todayStartMs) {
      callsToday += 1;
      accumulate(todayRate, c);
      let r = todayByCampaign.get(c.campaign_id);
      if (!r) {
        r = emptyRate();
        todayByCampaign.set(c.campaign_id, r);
      }
      accumulate(r, c);
    } else if (t >= yesterdayStartMs) {
      callsYesterday += 1;
    }
    if (t >= sevenDayStartMs && t < todayStartMs) callsPrior7d += 1;
  }
  finalizeRate(todayRate);
  for (const r of todayByCampaign.values()) finalizeRate(r);

  let messagesSentToday = 0;
  for (const m of sms) {
    const camp = index.get(m.campaign_id);
    if (!camp || camp.source === "ghost_portal" || camp.is_test === true) continue;
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    if (Number.isFinite(t) && t >= todayStartMs && (m.status === "sent" || m.status === "delivered")) {
      messagesSentToday += 1;
    }
  }

  const runningCampaigns: RunningCampaignCard[] = liveCampaigns
    .filter((c) => c.status === "running")
    .map((c) => ({
      id: c.id,
      name: c.name,
      country: parseCountryToken(c.name),
      cioWorkspace: c.cio_workspace ?? null,
      voiceId: c.voice_id ?? null,
      agentLabel: c.vapi_assistant_name ?? null,
      baseAssistantId: c.base_assistant_id ?? null,
      scheduleType: c.campaign_type === "recurring" ? "recurring" : "fixed",
      today: todayByCampaign.get(c.id) ?? emptyRate(),
      startAt: c.start_at ?? c.created_at ?? null,
      players: rosterByCampaign.get(c.id) ?? 0,
      perf: computeCampaignTodayPerf(
        liveCalls.filter((x) => x.campaign_id === c.id),
        liveSms.filter((x) => x.campaign_id === c.id),
        declinedIds,
        todayStartMs,
        todayStartMs + MS_PER_DAY,
      ),
    }));

  const runningVoiceIds = new Set(
    liveCampaigns.filter((c) => c.status === "running" && c.voice_id).map((c) => c.voice_id as string),
  );
  const allVoiceIds = new Set(liveCampaigns.filter((c) => c.voice_id).map((c) => c.voice_id as string));
  const sevenDayAvg = callsPrior7d / 7;

  return {
    dayUtc: utcDayString(todayStartMs),
    today: computeTodayPerf(liveCalls, liveSms, declinedIds, todayStartMs),
    yesterday: computeTodayPerf(liveCalls, liveSms, declinedIds, yesterdayStartMs),
    runningCampaigns,
    ops: {
      callsToday,
      callsYesterday,
      deltaVsYesterday: safeDiv(callsToday - callsYesterday, callsYesterday),
      sevenDayAvg,
      deltaVsSevenDayAvg: safeDiv(callsToday - sevenDayAvg, sevenDayAvg),
      connectRateToday: todayRate.connectRate,
      connectedToday: todayRate.connected,
      terminalToday: todayRate.terminal,
      reachToday: todayRate.reach,
      voicemailConnectedToday: todayRate.voicemailConnected,
      voicemailEvaluatedToday: todayRate.voicemailEvaluated,
      voicemailRateToday: todayRate.voicemailRate,
      messagesSentToday,
      messagesShareOfCalls: safeDiv(messagesSentToday, callsToday),
      messagesShareOfConnected: safeDiv(messagesSentToday, todayRate.connected),
      activeAgents: runningVoiceIds.size,
      totalAgents: allVoiceIds.size,
      idleAgents: Math.max(0, allVoiceIds.size - runningVoiceIds.size),
      runningCampaignCount: runningCampaigns.length,
    },
  };
}

// ── /today from the SQL rollups (VOZ-283 Task 3) ─────────────────────────────
// The rollups are lean (transcript-less); the ONE transcript-dependent bucket
// is isEarlyHangup's "customer-ended-call with ≤1 substantive turn" branch,
// which the lean rule files under neutral. The route fetches ONLY those
// candidate calls (+ their attached SMS) and passes per-day/per-campaign
// counts here; each breakdown then shifts neutral → earlyHangup by the
// window's candidate count. Byte-parity with computeToday is enforced by
// dashboardRollup.parity.test.ts.

export interface TodayCandidateDelta {
  /** UTC day → count of connected customer-ended-call ≤1-turn candidates (lean-neutral → early). */
  callByDay: Map<string, number>;
  /** UTC day (of the SMS created_at) → sent|delivered SMS attached to candidate calls. */
  smsByDay: Map<string, number>;
  /** Per campaign, TODAY only — feeds the running-campaign perf cards. */
  todayByCampaign: Map<string, { call: number; sms: number }>;
}

export function emptyCandidateDelta(): TodayCandidateDelta {
  return { callByDay: new Map(), smsByDay: new Map(), todayByCampaign: new Map() };
}

/** A candidate row: connected, non-voicemail, non-goal, contact NOT declined,
 *  ended_reason='customer-ended-call', duration NULL or ≥ EARLY_HANGUP_SEC —
 *  i.e. lean-neutral, transcript-decides. Callers pre-apply that predicate
 *  (SQL in the route; JS in the parity test) — keep the two in lockstep. */
export interface CandidateCallRow {
  id?: string | null;
  campaign_id: string;
  created_at?: string | null;
  transcript?: unknown;
}

/**
 * Turn candidate calls (+ their attached sent|delivered SMS) into the delta
 * maps computeTodayFromRollup consumes. Only candidates whose transcript shows
 * ≤1 substantive customer turn qualify (isEarlyHangup's transcript branch —
 * the ONE bucket the lean SQL rollup cannot classify).
 */
export function buildCandidateDelta(
  candidates: CandidateCallRow[],
  smsAttachments: Array<{ call_id?: string | null; created_at?: string | null }>,
  todayStartMs: number,
  turnCounter: (transcript: string) => number,
): TodayCandidateDelta {
  const delta = emptyCandidateDelta();
  const qualifying = new Map<string, CandidateCallRow>();
  for (const c of candidates) {
    if (turnCounter(transcriptText(c.transcript as DashCallRow["transcript"])) > 1) continue;
    if (c.id) qualifying.set(c.id, c); // no id → still day-counted; just can't match an SMS
    const t = c.created_at ? Date.parse(c.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const day = utcDayString(t);
    delta.callByDay.set(day, (delta.callByDay.get(day) ?? 0) + 1);
    if (t >= todayStartMs) {
      const g = delta.todayByCampaign.get(c.campaign_id) ?? { call: 0, sms: 0 };
      g.call += 1;
      delta.todayByCampaign.set(c.campaign_id, g);
    }
  }
  for (const m of smsAttachments) {
    const call = m.call_id ? qualifying.get(m.call_id) : undefined;
    if (!call) continue;
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    if (!Number.isFinite(t)) continue;
    const day = utcDayString(t);
    delta.smsByDay.set(day, (delta.smsByDay.get(day) ?? 0) + 1);
    if (t >= todayStartMs) {
      const g = delta.todayByCampaign.get(call.campaign_id) ?? { call: 0, sms: 0 };
      g.sms += 1;
      delta.todayByCampaign.set(call.campaign_id, g);
    }
  }
  return delta;
}

function dayUtcToMs(dayUtc: string): number {
  return Date.parse(`${dayUtc}T00:00:00Z`);
}

function sumDeltaInWindow(byDay: Map<string, number>, startMs: number, endMs: number): number {
  let k = 0;
  for (const [day, n] of byDay) {
    const t = dayUtcToMs(day);
    if (Number.isFinite(t) && t >= startMs && t < endMs) k += n;
  }
  return k;
}

function callBreakdownFromRollup(
  rows: CallRollupRow[],
  startMs: number,
  endMs: number,
  candidateDelta: number,
): CallBreakdown {
  const b: CallBreakdown = {
    // silentPickup stays 0 on the rollup path too (2026-08-13): the SQL rollup has
    // no turn counts. The rollup DDL needs a silent_pickup column before cutover.
    total: 0, terminal: 0, connected: 0, inFlight: 0, reach: 0, voicemail: 0, silentPickup: 0, unreachable: 0,
    // agentTimeout stays 0 on the rollup path: the SQL rollup predates the
    // agent_timeout tag (VOZ-330) and its rows can't split it out — those calls
    // remain inside early_hangup_lean/neutral_lean here. The VOZ-283 parity gate
    // will surface this the moment the rollup cutover is attempted; the rollup
    // DDL needs an agent_timeout column before this path can go live.
    positive: 0, neutral: 0, declined: 0, earlyHangup: 0, agentTimeout: 0,
  };
  for (const r of rows) {
    const t = dayUtcToMs(r.day_utc);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    b.total += r.attempts;
    b.terminal += r.terminal;
    b.connected += r.connected;
    b.voicemail += r.voicemail;
    b.reach += r.reach;
    b.positive += r.positive;
    b.declined += r.declined;
    b.earlyHangup += r.early_hangup_lean;
    b.neutral += r.neutral_lean;
  }
  b.unreachable = b.terminal - b.connected;
  b.inFlight = b.total - b.terminal;
  // Transcript delta: lean-neutral candidates are early hang-ups on the
  // transcript path (isEarlyHangup's customer-ended ≤1-turn branch).
  b.neutral -= candidateDelta;
  b.earlyHangup += candidateDelta;
  return b;
}

function smsBreakdownFromRollup(
  rows: SmsRollupRow[],
  startMs: number,
  endMs: number,
  candidateDelta: number,
): SmsBreakdown {
  const b: SmsBreakdown = { total: 0, reached: 0, voicemail: 0, silentPickup: 0, unreachable: 0, positive: 0, neutral: 0, declined: 0, earlyHangup: 0, agentTimeout: 0 };
  for (const r of rows) {
    const t = dayUtcToMs(r.day_utc);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    b.total += r.sent;
    b.reached += r.reached;
    b.voicemail += r.voicemail;
    b.unreachable += r.unreachable;
    b.positive += r.positive;
    b.neutral += r.neutral;
    b.declined += r.declined;
  }
  // Transcript delta: the attached call flips neutral → early_hangup (now a
  // NAMED sub-row, Val 2026-08-07), so the count moves between buckets.
  b.neutral -= candidateDelta;
  b.earlyHangup += candidateDelta;
  // The lean SQL rollup can't split early-hangup vs agent-timeout texts (no
  // ended_reason in its SMS rows) — reconcile the remainder into earlyHangup so
  // the named partition still sums to `reached`; agentTimeout stays 0 on this
  // path until the rollup DDL learns the tag (same VOZ-283 parity note as
  // callBreakdownFromRollup above).
  b.earlyHangup += Math.max(0, b.reached - b.positive - b.neutral - b.declined - b.earlyHangup);
  return b;
}

/**
 * Windowed 3-card summary over a SET of campaigns, summed from the same
 * day-grain rollup rows the Campaign Performance table is built from — so the
 * section's summary block always equals the sum of the rows it sits above
 * (Val 2026-08-07: "summary reflects totals across all campaigns matching the
 * filters"). Bounds are inclusive ms timestamps (null = open side); rollup rows
 * are day-grain, judged by their UTC day start — matching how the table's own
 * per-row perf blocks window. Same lean semantics + agent_timeout caveat as
 * the table (see the rollup-DDL notes above). Pure; client-safe.
 */
export function summarizeRollupWindow(
  callRollup: CallRollupRow[],
  smsRollup: SmsRollupRow[],
  campaignIds: ReadonlySet<string>,
  fromMs: number | null,
  toMs: number | null,
): TodayPerfDay {
  const lo = fromMs ?? Number.NEGATIVE_INFINITY;
  const hi = toMs === null ? Number.POSITIVE_INFINITY : toMs + 1; // breakdown fns treat the end as exclusive
  return assembleWindowPerf(
    callBreakdownFromRollup(callRollup.filter((r) => campaignIds.has(r.campaign_id)), lo, hi, 0),
    smsBreakdownFromRollup(smsRollup.filter((r) => campaignIds.has(r.campaign_id)), lo, hi, 0),
  );
}

/** RateRow from rollup rows in [startMs, endMs) — mirrors accumulate()+finalizeRate(). */
function rateRowFromRollup(rows: CallRollupRow[], startMs: number, endMs: number): RateRow {
  const row = emptyRate();
  for (const r of rows) {
    const t = dayUtcToMs(r.day_utc);
    if (!Number.isFinite(t) || t < startMs || t >= endMs) continue;
    row.calls += r.attempts;
    row.connected += r.connected;
    row.terminal += r.terminal;
    row.successful += r.successful;
    row.voicemailConnected += r.voicemail;
    row.voicemailEvaluated += r.voicemail_evaluated;
  }
  return finalizeRate(row);
}

/**
 * Rollup-sourced twin of computeToday: SAME TodaySnapshot output. The rollups
 * must span [now − 10d, now] (today + yesterday + each day's prior-7d window);
 * `delta` carries the transcript-dependent candidate counts (see
 * TodayCandidateDelta). Card assembly reuses assembleTodayPerf /
 * assembleWindowPerf — the exact code bodies the raw path uses.
 */
export function computeTodayFromRollup(
  callRollup: CallRollupRow[],
  smsRollup: SmsRollupRow[],
  campaigns: DashCampaignRow[],
  now: number,
  delta: TodayCandidateDelta = emptyCandidateDelta(),
  rosterByCampaign: Map<string, number> = new Map(),
): TodaySnapshot {
  const liveCampaigns = campaigns.filter((c) => c.source !== "ghost_portal" && c.is_test !== true);

  const todayStartMs = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const yesterdayStartMs = todayStartMs - MS_PER_DAY;
  const sevenDayStartMs = todayStartMs - 7 * MS_PER_DAY;
  const farFutureMs = todayStartMs + MS_PER_DAY;

  // ops counters (todayRate mirrors the accumulate() pass over today's calls).
  const todayRate = rateRowFromRollup(callRollup, todayStartMs, farFutureMs);
  let callsToday = 0;
  let callsYesterday = 0;
  let callsPrior7d = 0;
  for (const r of callRollup) {
    const t = dayUtcToMs(r.day_utc);
    if (!Number.isFinite(t)) continue;
    if (t >= todayStartMs) callsToday += r.attempts;
    else if (t >= yesterdayStartMs) callsYesterday += r.attempts;
    if (t >= sevenDayStartMs && t < todayStartMs) callsPrior7d += r.attempts;
  }
  let messagesSentToday = 0;
  for (const r of smsRollup) {
    const t = dayUtcToMs(r.day_utc);
    if (Number.isFinite(t) && t >= todayStartMs) messagesSentToday += r.sent;
  }

  // Day blocks (delta-ful) — windows mirror computeTodayPerf exactly.
  const perfDay = (dayStartMs: number): TodayPerfDay => {
    const dEnd = dayStartMs + MS_PER_DAY;
    const cb = callBreakdownFromRollup(callRollup, dayStartMs, dEnd, sumDeltaInWindow(delta.callByDay, dayStartMs, dEnd));
    const sb = smsBreakdownFromRollup(smsRollup, dayStartMs, dEnd, sumDeltaInWindow(delta.smsByDay, dayStartMs, dEnd));
    const cbP = callBreakdownFromRollup(callRollup, dayStartMs - MS_PER_DAY, dayStartMs, sumDeltaInWindow(delta.callByDay, dayStartMs - MS_PER_DAY, dayStartMs));
    const sbP = smsBreakdownFromRollup(smsRollup, dayStartMs - MS_PER_DAY, dayStartMs, sumDeltaInWindow(delta.smsByDay, dayStartMs - MS_PER_DAY, dayStartMs));
    const cb7 = callBreakdownFromRollup(callRollup, dayStartMs - 7 * MS_PER_DAY, dayStartMs, sumDeltaInWindow(delta.callByDay, dayStartMs - 7 * MS_PER_DAY, dayStartMs));
    const sb7 = smsBreakdownFromRollup(smsRollup, dayStartMs - 7 * MS_PER_DAY, dayStartMs, sumDeltaInWindow(delta.smsByDay, dayStartMs - 7 * MS_PER_DAY, dayStartMs));
    return assembleTodayPerf(cb, sb, cbP, sbP, cb7, sb7);
  };

  // Per-campaign rollup rows, grouped once.
  const callByCampaign = new Map<string, CallRollupRow[]>();
  for (const r of callRollup) {
    const g = callByCampaign.get(r.campaign_id);
    if (g) g.push(r); else callByCampaign.set(r.campaign_id, [r]);
  }
  const smsByCampaign = new Map<string, SmsRollupRow[]>();
  for (const r of smsRollup) {
    const g = smsByCampaign.get(r.campaign_id);
    if (g) g.push(r); else smsByCampaign.set(r.campaign_id, [r]);
  }

  const runningCampaigns: RunningCampaignCard[] = liveCampaigns
    .filter((c) => c.status === "running")
    .map((c) => {
      const campDelta = delta.todayByCampaign.get(c.id) ?? { call: 0, sms: 0 };
      const cRoll = callByCampaign.get(c.id) ?? [];
      const cb = callBreakdownFromRollup(cRoll, todayStartMs, farFutureMs, campDelta.call);
      const sb = smsBreakdownFromRollup(smsByCampaign.get(c.id) ?? [], todayStartMs, farFutureMs, campDelta.sms);
      return {
        id: c.id,
        name: c.name,
        country: parseCountryToken(c.name),
        cioWorkspace: c.cio_workspace ?? null,
        voiceId: c.voice_id ?? null,
        agentLabel: c.vapi_assistant_name ?? null,
        baseAssistantId: c.base_assistant_id ?? null,
        scheduleType: c.campaign_type === "recurring" ? ("recurring" as const) : ("fixed" as const),
        today: rateRowFromRollup(cRoll, todayStartMs, farFutureMs),
        startAt: c.start_at ?? c.created_at ?? null,
        players: rosterByCampaign.get(c.id) ?? 0,
        perf: assembleWindowPerf(cb, sb),
      };
    });

  const runningVoiceIds = new Set(
    liveCampaigns.filter((c) => c.status === "running" && c.voice_id).map((c) => c.voice_id as string),
  );
  const allVoiceIds = new Set(liveCampaigns.filter((c) => c.voice_id).map((c) => c.voice_id as string));
  const sevenDayAvg = callsPrior7d / 7;

  return {
    dayUtc: utcDayString(todayStartMs),
    today: perfDay(todayStartMs),
    yesterday: perfDay(yesterdayStartMs),
    runningCampaigns,
    ops: {
      callsToday,
      callsYesterday,
      deltaVsYesterday: safeDiv(callsToday - callsYesterday, callsYesterday),
      sevenDayAvg,
      deltaVsSevenDayAvg: safeDiv(callsToday - sevenDayAvg, sevenDayAvg),
      connectRateToday: todayRate.connectRate,
      connectedToday: todayRate.connected,
      terminalToday: todayRate.terminal,
      reachToday: todayRate.reach,
      voicemailConnectedToday: todayRate.voicemailConnected,
      voicemailEvaluatedToday: todayRate.voicemailEvaluated,
      voicemailRateToday: todayRate.voicemailRate,
      messagesSentToday,
      messagesShareOfCalls: safeDiv(messagesSentToday, callsToday),
      messagesShareOfConnected: safeDiv(messagesSentToday, todayRate.connected),
      activeAgents: runningVoiceIds.size,
      totalAgents: allVoiceIds.size,
      idleAgents: Math.max(0, allVoiceIds.size - runningVoiceIds.size),
      runningCampaignCount: runningCampaigns.length,
    },
  };
}
