// src/lib/northStarMath.ts
// PURE north-star aggregation — NO I/O, no env (mirrors campaignAnalytics.ts /
// qaScoreMath.ts). The reader (northStarData.ts) fetches rows; this joins calls↔sms
// and computes the delivered-among-goal metric (MLOps §A8/§4.5): of calls where the
// agent secured consent (goal_reached === true), what share got a DELIVERED offer SMS
// — plus the two leaks (consent but NO sms queued; consent but sms failed).

export interface NsCallRow {
  id: string;
  campaign_id: string;
  goal_reached?: boolean | null;
}
export interface NsSmsRow {
  call_id?: string | null;
  status?: string | null;
}
export interface NsCampaignRow {
  id: string;
  name: string;
  is_test?: boolean | null;
}

export type SmsOutcome = "delivered" | "failed" | "inFlight" | "noSms";

export interface NorthStarCampaign {
  id: string;
  name: string;
  isTest: boolean;
  goalReached: number;
  delivered: number;
  failed: number;
  inFlight: number;
  noSms: number;
  deliveredAmongGoal: number | null;
  failedAmongGoal: number | null;
  noSmsAmongGoal: number | null;
}
export interface NorthStarPortfolio {
  goalReached: number;
  delivered: number;
  failed: number;
  inFlight: number;
  noSms: number;
  deliveredAmongGoal: number | null;
  failedAmongGoal: number | null;
  noSmsAmongGoal: number | null;
  includedCampaigns: number;
  excludedTestCampaigns: number;
  excludedThinCampaigns: number;
}
export interface NorthStarResult {
  portfolio: NorthStarPortfolio;
  perCampaign: NorthStarCampaign[];
}

// Below this many goal-reached calls a campaign is too thin to anchor the portfolio
// rate (it still appears in perCampaign so the operator sees it, by its own count).
export const THIN_GOAL_FLOOR = 5;

/** null (never NaN) when denominator <= 0 — mirrors campaignAnalytics.safeDiv. */
function safeDiv(num: number, den: number): number | null {
  if (!Number.isFinite(den) || den <= 0) return null;
  return Number((num / den).toFixed(4));
}

/** PURE: a goal-reached call's SMS outcome from its (0+) sms statuses.
 *  delivered > failed > inFlight precedence; none/unknown ⇒ noSms (the pipeline leak). */
export function classifySms(statuses: Array<string | null | undefined>): SmsOutcome {
  if (statuses.length === 0) return "noSms";
  if (statuses.some((s) => s === "delivered")) return "delivered";
  if (statuses.some((s) => s === "failed" || s === "undelivered")) return "failed";
  if (statuses.some((s) => s === "queued" || s === "sent")) return "inFlight";
  return "noSms";
}

export function computeNorthStar(input: {
  calls: NsCallRow[];
  sms: NsSmsRow[];
  campaigns: NsCampaignRow[];
}): NorthStarResult {
  // sms grouped by call_id (skip null — an unlinked SMS can't tie to a goal).
  const smsByCall = new Map<string, Array<string | null | undefined>>();
  for (const m of input.sms) {
    if (!m.call_id) continue;
    const arr = smsByCall.get(m.call_id);
    if (arr) arr.push(m.status);
    else smsByCall.set(m.call_id, [m.status]);
  }

  const meta = new Map<string, { name: string; isTest: boolean }>();
  for (const c of input.campaigns) meta.set(c.id, { name: c.name, isTest: c.is_test === true });

  interface Acc {
    delivered: number;
    failed: number;
    inFlight: number;
    noSms: number;
    goalReached: number;
  }
  const byCampaign = new Map<string, Acc>();
  for (const call of input.calls) {
    if (call.goal_reached !== true) continue; // strict — mirrors analytics G2
    let acc = byCampaign.get(call.campaign_id);
    if (!acc) {
      acc = { delivered: 0, failed: 0, inFlight: 0, noSms: 0, goalReached: 0 };
      byCampaign.set(call.campaign_id, acc);
    }
    acc.goalReached++;
    acc[classifySms(smsByCall.get(call.id) ?? [])]++;
  }

  const perCampaign: NorthStarCampaign[] = [];
  let excludedTestCampaigns = 0;
  for (const [id, acc] of byCampaign) {
    const m = meta.get(id);
    const isTest = m?.isTest ?? false;
    if (isTest) excludedTestCampaigns++;
    perCampaign.push({
      id,
      name: m?.name ?? id,
      isTest,
      goalReached: acc.goalReached,
      delivered: acc.delivered,
      failed: acc.failed,
      inFlight: acc.inFlight,
      noSms: acc.noSms,
      deliveredAmongGoal: safeDiv(acc.delivered, acc.goalReached),
      failedAmongGoal: safeDiv(acc.failed, acc.goalReached),
      noSmsAmongGoal: safeDiv(acc.noSms, acc.goalReached),
    });
  }

  // Portfolio = volume-weighted over NON-TEST campaigns meeting the thin floor.
  let pd = 0;
  let pf = 0;
  let pi = 0;
  let pn = 0;
  let pg = 0;
  let included = 0;
  let thin = 0;
  for (const c of perCampaign) {
    if (c.isTest) continue;
    if (c.goalReached < THIN_GOAL_FLOOR) {
      thin++;
      continue;
    }
    pd += c.delivered;
    pf += c.failed;
    pi += c.inFlight;
    pn += c.noSms;
    pg += c.goalReached;
    included++;
  }

  const visible = perCampaign
    .filter((c) => !c.isTest && c.goalReached > 0)
    .sort((a, b) => (a.deliveredAmongGoal ?? 1) - (b.deliveredAmongGoal ?? 1)); // worst first

  // delivered + failed + noSms + inFlight === goalReached, but inFlight (transient
  // queued/sent) is intentionally excluded from the amongGoal shares below — so
  // deliveredAmongGoal + failedAmongGoal + noSmsAmongGoal can sum to < 1 mid-flight.
  return {
    portfolio: {
      goalReached: pg,
      delivered: pd,
      failed: pf,
      inFlight: pi,
      noSms: pn,
      deliveredAmongGoal: safeDiv(pd, pg),
      failedAmongGoal: safeDiv(pf, pg),
      noSmsAmongGoal: safeDiv(pn, pg),
      includedCampaigns: included,
      excludedTestCampaigns,
      excludedThinCampaigns: thin,
    },
    perCampaign: visible,
  };
}
