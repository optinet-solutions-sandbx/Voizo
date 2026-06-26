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
import { ANALYTICS_CONFIG } from "./analyticsConfig";
import { substantiveUserTurnCount } from "./transcriptClassify";

const MS_PER_DAY = 86_400_000;

// ── Input row shapes (only the columns the dashboard selects) ────────────────
export interface DashCallRow {
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
  start_at?: string | null;
  created_at?: string | null;
  end_at?: string | null;
  timezone?: string | null; // IANA tz for local-time heatmap bucketing (falls back to UTC when absent)
}
export interface DashSmsRow {
  campaign_id: string;
  created_at?: string | null;
  status?: string | null;
}

export interface DashFilters {
  startMs: number; // window start (inclusive)
  endMs: number; // window end (inclusive)
  campaignIds?: string[] | null; // null/undefined = all
  voiceId?: string | null; // single agent (campaign.voice_id)
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
  lastCallAtMs: number | null; // most recent call created_at in scope (for the Ended derivation)
}

// Derived DISPLAY status (Jasiel 2026-06-15): a paused campaign that's past its
// scheduled end_at, or hasn't dialed in `idleDays`, reads as done. PRESENTATION-ONLY —
// never mutates campaigns_v2.status or the scheduler.
export type DisplayStatus = "running" | "completed" | "ended" | "paused" | "inactive";

export function deriveDisplayStatus(opts: {
  rawStatus: string | null;
  endAtMs: number | null;
  lastCallMs: number | null;
  nowMs: number;
  idleDays?: number;
}): DisplayStatus {
  const { rawStatus, endAtMs, lastCallMs, nowMs, idleDays = 7 } = opts;
  const s = (rawStatus ?? "").toLowerCase();
  if (s === "running") return "running"; // trust a live status
  if (s === "inactive" || s === "draft") return "inactive";
  if (s === "completed") return "completed";
  if (endAtMs !== null && endAtMs <= nowMs) return "completed"; // reached its scheduled end
  if (s === "paused") {
    const idleMs = idleDays * MS_PER_DAY;
    if (lastCallMs === null || nowMs - lastCallMs >= idleMs) return "ended"; // stale → done
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
  successRate: number;
  calls: number;
}

export interface RunningCampaignCard {
  id: string;
  name: string;
  country: string;
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  today: RateRow;
}

export interface TodaySnapshot {
  dayUtc: string; // YYYY-MM-DD (UTC)
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
    voicemailConnected: 0, voicemailEvaluated: 0, reach: 0, voicemailRate: null,
  };
}

function accumulate(row: RateRow, c: DashCallRow): void {
  row.calls += 1;
  if (isConnected(c.status)) {
    row.connected += 1;
    // Voicemail/reach: only CONNECTED ('completed') calls can be a voicemail. NULL = not
    // evaluated (historical/pre-deploy) → excluded from the rate denominator.
    if (c.voicemail === true) row.voicemailConnected += 1;
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

/** Best performer by successRate, gated by a minimum connected-call volume so a 1–2 call
 *  campaign/agent can't show as "best" (Val's requirement). Returns null when none qualify. */
export function bestBySuccess<T extends RateRow>(
  rows: T[],
  labelOf: (r: T) => { key: string; label: string },
  minConnected = ANALYTICS_CONFIG.SAMPLE_FLOOR_THIN,
): BestPerformer | null {
  let best: BestPerformer | null = null;
  for (const r of rows) {
    if (r.connected < minConnected || r.successRate === null) continue;
    const { key, label } = labelOf(r);
    if (!best || r.successRate > best.successRate) {
      best = { key, label, successRate: r.successRate, calls: r.calls };
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
    bestCampaign: bestBySuccess(campaignRollups, (r) => ({ key: r.id, label: r.name })),
    bestAgent: bestBySuccess(agentRollups, (r) => ({ key: r.baseAssistantId, label: r.baseAssistantId })),
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

/** Short, human-ish label for a prompt: a snippet of its OPERATOR text + the first 4 sha chars.
 *  De-boilerplates by stripping everything up to and including SYSTEM_INSTRUCTIONS_END (the operator
 *  prompt follows it); prefix-less prompts (no marker) are snippeted from the start unchanged. The UI
 *  prepends the base-agent name (resolved client-side) for the full "Tom · snippet · sha" label. */
export function promptLabel(systemPrompt: string, sha: string): string {
  let text = systemPrompt ?? "";
  const endIdx = text.indexOf(SYSTEM_INSTRUCTIONS_END);
  if (endIdx >= 0) text = text.slice(endIdx + SYSTEM_INSTRUCTIONS_END.length);
  const cleaned = text.replace(/\s+/g, " ").trim();
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
  calls: number;
}

/** Per-day connect/success rates over [startMs, endMs], zero-filled so the x-axis is even. */
export function computeTrend(calls: DashCallRow[], startMs: number, endMs: number): TrendPoint[] {
  const byDay = rollup(calls, (c) => (c.created_at ? utcDayString(Date.parse(c.created_at)) : null));
  const out: TrendPoint[] = [];
  const first = Date.UTC(
    new Date(startMs).getUTCFullYear(),
    new Date(startMs).getUTCMonth(),
    new Date(startMs).getUTCDate(),
  );
  for (let t = first; t <= endMs; t += MS_PER_DAY) {
    const r = byDay.get(utcDayString(t));
    out.push({ day: utcDayString(t), connectRate: r?.connectRate ?? null, successRate: r?.successRate ?? null, calls: r?.calls ?? 0 });
  }
  return out;
}

// ── Daily call volume (stacked by campaign) ──────────────────────────────────
export interface VolumeSeries {
  key: string; // campaignId, or "other"
  name: string;
}
export interface VolumeResult {
  days: Array<Record<string, number | string>>; // { day, [campaignId|"other"]: count }
  series: VolumeSeries[]; // top-N campaigns by volume + an "Other" bucket
}

/** Calls per day, stacked by campaign. Capped to the top-N campaigns by total calls; the
 *  rest fold into "other" so the stacked bar stays readable. Zero-filled day range. */
export function computeDailyVolume(
  calls: DashCallRow[],
  campaigns: DashCampaignRow[],
  startMs: number,
  endMs: number,
  topN = 10,
): VolumeResult {
  const totalByCampaign = new Map<string, number>();
  for (const c of calls) totalByCampaign.set(c.campaign_id, (totalByCampaign.get(c.campaign_id) ?? 0) + 1);
  const sorted = [...totalByCampaign.entries()].sort((a, b) => b[1] - a[1]);
  const topIds = new Set(sorted.slice(0, topN).map(([id]) => id));
  const index = buildCampaignIndex(campaigns);

  const byDay = new Map<string, Record<string, number>>();
  for (const c of calls) {
    if (!c.created_at) continue;
    const day = utcDayString(Date.parse(c.created_at));
    const key = topIds.has(c.campaign_id) ? c.campaign_id : "other";
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

  const series: VolumeSeries[] = sorted.slice(0, topN).map(([id]) => ({ key: id, name: index.get(id)?.name ?? id }));
  if (sorted.length > topN) series.push({ key: "other", name: "Other campaigns" });
  return { days, series };
}

// ── Daily × hourly heatmap (call volume by date/hour + per-slot breakdown) ───
export interface HeatBreakdown {
  name: string; // raw campaign name (UI formats)
  calls: number;
  connected: number;
  successful: number;
}
export interface HeatCell {
  day: string; // YYYY-MM-DD (UTC)
  hour: number; // 0..23 (UTC)
  calls: number;
  connected: number;
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
    successful: number;
    byCampaign: Map<string, { calls: number; connected: number; successful: number }>;
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
      cell = { day, hour, calls: 0, connected: 0, successful: 0, byCampaign: new Map() };
      cells.set(key, cell);
    }
    const conn = isConnected(c.status);
    const succ = c.goal_reached === true;
    cell.calls++;
    if (conn) cell.connected++;
    if (succ) cell.successful++;
    let bc = cell.byCampaign.get(c.campaign_id);
    if (!bc) {
      bc = { calls: 0, connected: 0, successful: 0 };
      cell.byCampaign.set(c.campaign_id, bc);
    }
    bc.calls++;
    if (conn) bc.connected++;
    if (succ) bc.successful++;
  }
  const out: HeatCell[] = [];
  for (const cell of cells.values()) {
    const breakdown: HeatBreakdown[] = [...cell.byCampaign.entries()]
      .map(([id, v]) => ({ name: index.get(id)?.name ?? id, calls: v.calls, connected: v.connected, successful: v.successful }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8);
    out.push({ day: cell.day, hour: cell.hour, calls: cell.calls, connected: cell.connected, successful: cell.successful, breakdown });
  }
  return { cells: out, localizedCalls, utcFallbackCalls };
}

// ── Campaign Performance table rows ──────────────────────────────────────────
export interface CampaignTableRow {
  id: string;
  name: string;
  country: string;
  displayStatus: DisplayStatus;
  scheduleType: "fixed" | "recurring";
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  calls: number;
  connected: number;
  terminal: number;
  successful: number;
  connectRate: number | null;
  successRate: number | null;
  players: number; // campaign roster size (campaign_numbers_v2 count) — lifetime, NOT windowed
  reach: number; // human-only connects in window = connected − voicemailConnected
  smsSent: number; // texts dispatched (delivered + in-flight) for this campaign
  startAt: string | null;
  endAt: string | null;
  lastCallAt: string | null;
}

/** All live (non-ghost, non-test) campaigns as table rows — INCLUDING zero-call ones
 *  (so paused/ended campaigns still appear). `calls` must already be windowed by the
 *  caller; `nowMs` injected. displayStatus uses the windowed last-call (accurate while
 *  the window ≥ idleDays, which the default 30d table window satisfies). */
export function computeCampaignTable(
  calls: DashCallRow[],
  campaigns: DashCampaignRow[],
  nowMs: number,
  idleDays = 7,
  numbers: Array<{ campaign_id: string }> = [],
  sms: DashSmsRow[] = [],
): CampaignTableRow[] {
  const index = buildCampaignIndex(campaigns);
  const rollupMap = new Map(computeCampaignRollups(calls, index).map((r) => [r.id, r]));
  // Players = full roster (lifetime; numbers are NOT windowed by the caller). SMS sent = every
  // message dispatched for the campaign (delivered + in-flight + failed/undelivered) — "sent" =
  // handed to the provider regardless of receipt, matching the report's "SMS sent" total.
  const playersByCampaign = new Map<string, number>();
  for (const n of numbers) playersByCampaign.set(n.campaign_id, (playersByCampaign.get(n.campaign_id) ?? 0) + 1);
  const smsByCampaign = new Map<string, number>();
  for (const m of sms) {
    const s = m.status ?? "";
    if (s === "delivered" || s === "queued" || s === "sent" || s === "failed" || s === "undelivered") {
      smsByCampaign.set(m.campaign_id, (smsByCampaign.get(m.campaign_id) ?? 0) + 1);
    }
  }
  return campaigns
    .filter((c) => c.source !== "ghost_portal" && c.is_test !== true)
    .map((c) => {
      const r = rollupMap.get(c.id);
      const lastCallMs = r?.lastCallAtMs ?? null;
      return {
        id: c.id,
        name: c.name,
        country: parseCountryToken(c.name),
        displayStatus: deriveDisplayStatus({
          rawStatus: c.status ?? null,
          endAtMs: c.end_at ? Date.parse(c.end_at) : null,
          lastCallMs,
          nowMs,
          idleDays,
        }),
        scheduleType: c.campaign_type === "recurring" ? "recurring" : "fixed",
        voiceId: c.voice_id ?? null,
        agentLabel: c.vapi_assistant_name ?? null,
        baseAssistantId: c.base_assistant_id ?? null,
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
  | "not_interested"
  | "awaiting_retry"
  | "voicemail"
  | "unreached"
  | "wrong_number";

export function deriveRecordStatus(outcome: string | null, anyGoal: boolean): RecordStatus {
  if (anyGoal) return "successful"; // a goal on any attempt wins
  switch ((outcome ?? "").toLowerCase()) {
    case "sent_sms":
    case "sms_delivered": // offer delivered by SMS (registered_optin voicemail follow-up) — retired from retries
      return "successful";
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
export type AttemptTag = "unreachable" | "voicemail" | "positive" | "declined" | "early_hangup" | "neutral";
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
}

export const ATTEMPT_TAG_LABELS: Record<ContactTag, string> = {
  unreachable: "Unreachable",
  voicemail: "Voicemail detected",
  positive: "Positive response",
  declined: "Declined",
  early_hangup: "Early hangup",
  neutral: "Neutral",
  awaiting_retry: "Awaiting retry",
  wrong_number: "Wrong number",
};

// Honest, plain-English definitions for each tag — surfaced as hover tooltips on the records
// outcome chips. These are PROXY classifications (best-effort, derived from call data), not
// verified labels; the wording discloses that without renaming the categories. Mirrors the
// "estimated" hint treatment on CampaignSummary's breakdown bars.
export const ATTEMPT_TAG_DESC: Record<ContactTag, string> = {
  positive: "Agreed to receive the offer SMS (goal reached) — not a confirmed sale.",
  neutral: "Connected to a person, but no clear positive or negative outcome was detected.",
  declined: "Contact declined the offer — applied to the whole contact, so it can show on earlier attempts too.",
  early_hangup: "Connected but ended with little or no real conversation — a quick hangup or no engagement.",
  voicemail: "Best-effort automated voicemail detection; may misclassify.",
  unreachable: "Call didn't connect (no answer, busy, or failed).",
  awaiting_retry: "Not yet resolved — still scheduled for another attempt.",
  wrong_number: "Marked as a wrong or invalid number.",
};

// Muted accents — MATCH src/components/analytics/CampaignSummary.tsx (calm palette, low chroma).
export const ATTEMPT_TAG_COLOR: Record<ContactTag, string> = {
  positive: "#5fb39a",
  neutral: "#8b939c",
  declined: "#cf8a8a",
  early_hangup: "#c9a86a",
  voicemail: "#9f90c9",
  unreachable: "#c98a8a",
  awaiting_retry: "#7fa8d0",
  wrong_number: "#8b939c",
};

// Contact-tag priority: funnel-furthest among a contact's attempt tags wins.
const CONTACT_TAG_PRIORITY: AttemptTag[] = ["positive", "declined", "neutral", "early_hangup", "voicemail", "unreachable"];

/** calls_v2.transcript is jsonb `{ text }` from the DB, but a plain string in unit tests. */
function transcriptText(t: DashCallRow["transcript"]): string {
  if (!t) return "";
  return typeof t === "string" ? t : (t.text ?? "");
}

/** Per-attempt outcome tag for a single call. `declinedContact` = the call's CONTACT has
 *  campaign_numbers_v2.outcome === 'declined_offer'. Mirrors campaignAnalytics' priority
 *  (voicemail===null is NOT voicemail — treated as a human). */
export function deriveAttemptTag(call: DashCallRow, declinedContact: boolean): AttemptTag {
  if (!isConnected(call.status)) return "unreachable";
  if (call.voicemail === true) return "voicemail";
  if (call.goal_reached === true) return "positive";
  if (declinedContact) return "declined";
  // Engagement (2026-06-26): a connected call with no real conversation, or a pickup-and-bail,
  // is an early hangup — not "neutral". Duration alone misses bails (a 30s clock with one "Hello?").
  const userTurns = substantiveUserTurnCount(transcriptText(call.transcript));
  if (userTurns === 0) return "early_hangup";
  if (call.ended_reason === "customer-ended-call" && userTurns <= 1) return "early_hangup";
  if (typeof call.duration_seconds === "number" && call.duration_seconds < ANALYTICS_CONFIG.EARLY_HANGUP_SEC)
    return "early_hangup";
  return "neutral";
}

/** One record per campaign_number: ordered per-attempt tags + a contact-level tag + last-attempt
 *  time. `calls` should be that campaign's calls. Numbers with no calls still produce a record. */
export function computeCallRecords(numbers: DashNumberRow[], calls: DashCallRow[]): CallRecord[] {
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
      return { index: i + 1, tag: deriveAttemptTag(c, declined), atMs: Number.isFinite(t) ? t : null };
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
      voiceId: c.voice_id ?? null,
      agentLabel: c.vapi_assistant_name ?? null,
      baseAssistantId: c.base_assistant_id ?? null,
      today: todayByCampaign.get(c.id) ?? emptyRate(),
    }));

  const runningVoiceIds = new Set(
    liveCampaigns.filter((c) => c.status === "running" && c.voice_id).map((c) => c.voice_id as string),
  );
  const allVoiceIds = new Set(liveCampaigns.filter((c) => c.voice_id).map((c) => c.voice_id as string));
  const sevenDayAvg = callsPrior7d / 7;

  return {
    dayUtc: utcDayString(todayStartMs),
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
