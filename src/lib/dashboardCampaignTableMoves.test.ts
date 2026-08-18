import { describe, it, expect } from "vitest";
import {
  buildCandidateDelta,
  callWindowBreakdown,
  smsWindowBreakdown,
  computeCampaignTableFromRollup,
  deriveAttemptTag,
  summarizeRollupWindow,
  type CallRollupRow,
  type SmsRollupRow,
  type DashCallRow,
  type DashCampaignRow,
  type DashSmsRow,
  type CandidateCallRow,
} from "./dashboardAnalytics";

/**
 * The campaigns table (`/api/dashboard/campaigns`) is served by
 * computeCampaignTableFromRollup, which hand-rolls its own CallBreakdown with
 * `silentPickup: 0` / `agentTimeout: 0` as LITERALS and leaves the silent
 * pickups inside `reach`. VOZ-387 wired the move map into /today only. Measured
 * over 4 complete UTC days: the surface reported Reached 980 where the shipped
 * classifier said 379 — and since VOZ-396 that number is labelled
 * "Conversations established".
 *
 * These tests gate against the CLASSIFIER, never against the lean path.
 * dashboardRollup.parity.test.ts cannot gate this: computeCampaignTable also
 * hard-codes {useTranscript:false}, so it compares lean against lean and passes
 * green with the surface 61% wrong.
 */

const DAY_UTC = "2026-08-14";
const T = Date.parse(DAY_UTC + "T09:00:00Z");
const DAY_MS = 86_400_000;
const DAY_START = Date.parse(DAY_UTC + "T00:00:00Z");
const CID = "camp-1";

const call = (id: string, over: Partial<DashCallRow> = {}): DashCallRow => ({
  id,
  campaign_id: CID,
  campaign_number_id: id,
  status: "completed",
  goal_reached: false,
  voicemail: false,
  created_at: new Date(T).toISOString(),
  ...over,
});

const sms = (call_id: string): DashSmsRow => ({
  campaign_id: CID,
  call_id,
  campaign_number_id: call_id,
  status: "delivered",
  created_at: new Date(T + 1000).toISOString(),
});

// One call per outcome the transcript can change, plus three the SQL gets right.
const CALLS: DashCallRow[] = [
  call("pos", { goal_reached: true }),
  call("vm", { voicemail: true }),
  // 0 user turns => silent_pickup. SQL sees 90s and says neutral.
  call("dead", { duration_seconds: 90, ended_reason: "assistant-ended-call" }),
  // 0 user turns => silent_pickup. SQL sees 8s and says early_hangup.
  call("dead2", { duration_seconds: 8, ended_reason: "customer-ended-call" }),
  // agent_timeout. SQL has no such arm and says early_hangup on duration.
  call("timeout", { duration_seconds: 3, ended_reason: "pipeline-error-openai-429-exceeded-quota" }),
  // 2 substantive turns => neutral on both paths.
  call("neu", { duration_seconds: 40, ended_reason: "customer-ended-call", transcript: "AI: hi\nUser: tell me more\nUser: yes go on" }),
  // 1 turn, <15s => early_hangup on both paths.
  call("early", { duration_seconds: 5, transcript: "AI: hi\nUser: Hello?" }),
  // declined contact, 1 turn => declined on both paths.
  call("decl", { duration_seconds: 30, ended_reason: "customer-ended-call", transcript: "AI: hi\nUser: not interested" }),
  call("unreach", { status: "failed" }),
];
const DECLINED = new Set(["decl"]);
const SMS_ROWS: DashSmsRow[] = CALLS.map((c) => sms(c.id as string));

/** The deployed rollup CASE (2026-08-04_dashboard_rollup_rpc.sql:50-57) as a
 *  FIXTURE, so the unit test can stand in for the RPC. It has no agent_timeout
 *  arm and cannot count turns, so a timeout or dead-air call lands in
 *  early_hangup / neutral by duration alone — that is the defect under test. */
function leanRollupRow(): CallRollupRow {
  const r = { positive: 0, declined: 0, early_hangup_lean: 0, neutral_lean: 0 };
  let attempts = 0;
  let terminal = 0;
  let connected = 0;
  let voicemail = 0;
  let successful = 0;
  let vmEval = 0;
  for (const c of CALLS) {
    attempts += 1;
    terminal += 1;
    if (c.goal_reached === true) successful += 1;
    if (c.status !== "completed" && c.status !== "answered") continue;
    connected += 1;
    if (c.voicemail !== null && c.voicemail !== undefined) vmEval += 1;
    if (c.voicemail === true && c.goal_reached !== true) {
      voicemail += 1;
      continue;
    }
    if (c.goal_reached === true) {
      r.positive += 1;
      continue;
    }
    if (DECLINED.has(c.campaign_number_id as string)) {
      r.declined += 1;
      continue;
    }
    if (c.ended_reason === "silence-timed-out" || (typeof c.duration_seconds === "number" && c.duration_seconds < 15)) {
      r.early_hangup_lean += 1;
    } else {
      r.neutral_lean += 1;
    }
  }
  return {
    campaign_id: CID,
    day_utc: DAY_UTC,
    attempts,
    terminal,
    connected,
    voicemail,
    reach: connected - voicemail,
    ...r,
    successful,
    voicemail_evaluated: vmEval,
    last_call_at: new Date(T).toISOString(),
  };
}

/** The SMS rollup row the RPC would emit: lean buckets, and no column for
 *  early-hangup or agent-timeout texts (they fold into `reached`). */
function leanSmsRollupRow(): SmsRollupRow {
  const lean = smsWindowBreakdown(SMS_ROWS, CALLS, DECLINED, DAY_START, DAY_START + DAY_MS, { useTranscript: false });
  return {
    campaign_id: CID,
    day_utc: DAY_UTC,
    sent: lean.total,
    reached: lean.reached,
    voicemail: lean.voicemail,
    unreachable: lean.unreachable,
    positive: lean.positive,
    neutral: lean.neutral,
    declined: lean.declined,
  };
}

// The route's candidate predicate: connected, voicemail NOT TRUE, goal NOT TRUE.
const CANDIDATES: CandidateCallRow[] = CALLS.filter(
  (c) => (c.status === "completed" || c.status === "answered") && c.voicemail !== true && c.goal_reached !== true,
) as CandidateCallRow[];

const CAMPAIGNS: DashCampaignRow[] = [
  {
    id: CID,
    name: "L7_AU_TEST",
    status: "running",
    source: "app",
    is_test: false,
    campaign_type: "fixed",
    created_at: new Date(T - DAY_MS).toISOString(),
  } as DashCampaignRow,
];

// The move map the route must build — the REAL buildCandidateDelta over the real candidates.
const delta = buildCandidateDelta(
  CANDIDATES,
  SMS_ROWS.map((m) => ({ call_id: m.call_id, created_at: m.created_at })),
  DAY_START,
  DECLINED,
);

const table = () =>
  computeCampaignTableFromRollup(
    [leanRollupRow()],
    [leanSmsRollupRow()],
    CAMPAIGNS,
    T + DAY_MS,
    30,
    new Map(),
    delta.campaignMoveRows,
  );

describe("campaigns table must carry the transcript move map (VOZ-387 follow-through)", () => {
  // The number Val reads. Ground truth = the shipped classifier, transcript ON.
  const truth = callWindowBreakdown(CALLS, DECLINED, DAY_START, DAY_START + DAY_MS);
  const smsTruth = smsWindowBreakdown(SMS_ROWS, CALLS, DECLINED, DAY_START, DAY_START + DAY_MS);

  it("fixture sanity: the SQL-lean rollup really does inflate Reached (positive control)", () => {
    expect(truth.reach).toBe(5); // pos, timeout, neu, early, decl
    expect(truth.silentPickup).toBe(2); // dead, dead2
    expect(truth.agentTimeout).toBe(1); // timeout
    expect(leanRollupRow().reach).toBe(7); // lean cannot see the 2 dead-air pickups
  });

  it("row.reach matches deriveAttemptTag(useTranscript:true) — NOT the lean bucket", () => {
    const rows = table();
    expect(rows[0].reach).toBe(truth.reach);
    // Since VOZ-396 the card total is "Conversations established" = reach − early hangups.
    expect(rows[0].perf.reached.total).toBe(truth.reach - truth.earlyHangup);
  });

  it("silentPickup and agentTimeout are computed, not literal 0", () => {
    const perf = table()[0].perf;
    const sp = perf.callAttempts.rows.find((r) => r.key === "silent_pickup");
    expect(sp?.count).toBe(truth.silentPickup);
    const at = perf.reached.rows.find((r) => r.key === "agent_timeout");
    expect(at?.count).toBe(truth.agentTimeout);
  });

  it("early hang-up is a classified count, not the subtraction remainder", () => {
    const perf = table()[0].perf;
    // VOZ-396: Early hang-up is a top-level Call-attempts row.
    const eh = perf.callAttempts.rows.find((r) => r.key === "early_hangup");
    expect(eh?.count).toBe(truth.earlyHangup);
    // SMS side: the same remainder defect on the same surface. The remainder used
    // to absorb agent-timeout and silent-pickup texts under an "Early hang-up" label.
    const smsEh = perf.sms.rows.find((r) => r.key === "early_hangup");
    expect(smsEh?.count).toBe(smsTruth.earlyHangup);
    const smsSp = perf.sms.rows.find((r) => r.key === "silent_pickup");
    expect(smsSp?.count).toBe(smsTruth.silentPickup);
    const smsAt = perf.sms.rows.find((r) => r.key === "reached")?.subRows?.find((r) => r.key === "agent_timeout");
    expect(smsAt?.count).toBe(smsTruth.agentTimeout);
    expect(perf.sms.total).toBe(smsTruth.total);
  });

  it("summarizeRollupWindow (the section summary block) carries the same map", () => {
    const perf = summarizeRollupWindow(
      [leanRollupRow()],
      [leanSmsRollupRow()],
      new Set([CID]),
      DAY_START,
      DAY_START + DAY_MS - 1,
      delta.campaignMoveRows,
    );
    expect(perf.reached.total).toBe(truth.reach - truth.earlyHangup);
    expect(perf.callAttempts.rows.find((r) => r.key === "silent_pickup")?.count).toBe(truth.silentPickup);
    // Val 2026-08-07: sub-rows must sum to the card total.
    expect(perf.reached.rows.reduce((s, r) => s + r.count, 0)).toBe(perf.reached.total);
    expect(perf.callAttempts.rows.reduce((s, r) => s + r.count, 0)).toBe(perf.callAttempts.total);
    expect(perf.sms.rows.reduce((s, r) => s + r.count, 0)).toBe(perf.sms.total);
  });

  // Justifies CampaignTable's `summaryNoDrillHint`: the section-summary drawer
  // (/api/dashboard/records) classifies LEAN, and the lean classifier gates the
  // silent_pickup branch on useTranscript — so it can never emit that tag, and a
  // drill-down would open an empty list under a non-zero card count. If this test
  // ever fails, lean CAN emit silent_pickup and the suppression should be removed.
  it("the lean classifier can never emit silent_pickup (the reason the summary row does not drill)", () => {
    const dead = CALLS.filter((c) => c.id === "dead" || c.id === "dead2");
    expect(dead).toHaveLength(2);
    for (const c of dead) {
      expect(deriveAttemptTag(c, false)).toBe("silent_pickup"); // rich sees it
      expect(deriveAttemptTag(c, false, { useTranscript: false })).not.toBe("silent_pickup"); // lean cannot
    }
    // And the lean breakdown puts them back inside reach, which is the inflation.
    const lean = callWindowBreakdown(CALLS, DECLINED, DAY_START, DAY_START + DAY_MS, { useTranscript: false });
    expect(lean.silentPickup).toBe(0);
    expect(lean.reach).toBe(truth.reach + truth.silentPickup);
  });

  it("move rows are JSON-safe — they cross the wire to CampaignTable / campaignPerfCsv", () => {
    expect(JSON.parse(JSON.stringify(delta.campaignMoveRows))).toEqual(delta.campaignMoveRows);
    expect(delta.campaignMoveRows.length).toBeGreaterThan(0);
    expect(delta.campaignMoveRows.every((r) => r.campaign_id === CID && r.day_utc === DAY_UTC)).toBe(true);
  });
});
