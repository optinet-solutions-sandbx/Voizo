import type { AnalyticsInput, CampaignRow, NumberRow, CallRow, SmsRow } from "./campaignAnalytics";

/**
 * Fixture campaigns:
 *  - "big"  : real, high-volume — exercises conversion/yield/median/confidence(full).
 *  - "thin" : real, tiny — connected < SAMPLE_FLOOR_THIN (10) => thin, excluded from median.
 *  - "test" : is_test=true — excluded from portfolio (G3).
 *
 * Hand-computed expectations (CONNECTED = completed|answered; answered never written
 * in prod but kept in the set to mirror canon — fixtures use only 'completed'):
 *
 *  big: targeted=4 numbers (n1..n4).
 *    calls: n1 completed+goal; n1 completed (no goal); n2 completed+goal; n3 no_answer; n3 completed (no goal); n4 failed.
 *    totalCalls=6; connected(completed)=4; goalCalls=2; goalNumbers=distinct{n1,n2}=2.
 *    conversion=2/4=0.5; yield=2/4=0.5.
 *    connectRate=connected/(connected+terminal nonconnect)=4/(4+2[no_answer,failed])=4/6≈0.6667.
 *    dialedNumbers=distinct{n1,n2,n3,n4}=4; connectedNumbers=distinct{n1,n2,n3}=3; reachability=3/4=0.75.
 *  thin: targeted=2; calls: n5 completed+goal; n6 no_answer. connected=1; goalCalls=1; conversion=1/1=1; yield=1/2=0.5.
 *  test: targeted=1; calls: n7 completed+goal. connected=1; conversion=1; yield=1.
 */
export const FIXTURE_NOW = Date.parse("2026-06-02T12:00:00Z");

const campaigns: CampaignRow[] = [
  { id: "big", name: "L7_AU_Big", status: "completed", is_test: false, start_at: "2026-05-19T00:00:00Z", created_at: "2026-05-19T00:00:00Z", end_at: null, campaign_type: "fixed" },
  { id: "thin", name: "L7_CA_Thin", status: "completed", is_test: false, start_at: "2026-06-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z", end_at: null, campaign_type: "fixed" },
  { id: "test", name: "TEST_smoke", status: "completed", is_test: true, start_at: "2026-06-01T00:00:00Z", created_at: "2026-06-01T00:00:00Z", end_at: null, campaign_type: "fixed" },
];

const numbers: NumberRow[] = [
  { id: "n1", campaign_id: "big", outcome: "sent_sms", attempt_count: 2, created_at: "2026-05-19T00:00:00Z" },
  { id: "n2", campaign_id: "big", outcome: "sent_sms", attempt_count: 1, created_at: "2026-05-19T00:00:00Z" },
  { id: "n3", campaign_id: "big", outcome: "not_interested", attempt_count: 2, created_at: "2026-05-19T00:00:00Z" },
  { id: "n4", campaign_id: "big", outcome: "unreached", attempt_count: 1, created_at: "2026-05-19T00:00:00Z" },
  { id: "n5", campaign_id: "thin", outcome: "sent_sms", attempt_count: 1, created_at: "2026-06-01T00:00:00Z" },
  { id: "n6", campaign_id: "thin", outcome: "pending", attempt_count: 0, created_at: "2026-06-01T00:00:00Z" },
  { id: "n7", campaign_id: "test", outcome: "sent_sms", attempt_count: 1, created_at: "2026-06-01T00:00:00Z" },
];

const calls: CallRow[] = [
  { campaign_id: "big", campaign_number_id: "n1", status: "completed", goal_reached: true, duration_seconds: 120, created_at: "2026-05-30T10:00:00Z" },
  { campaign_id: "big", campaign_number_id: "n1", status: "completed", goal_reached: false, duration_seconds: 30, created_at: "2026-05-28T10:00:00Z" },
  { campaign_id: "big", campaign_number_id: "n2", status: "completed", goal_reached: true, duration_seconds: 90, created_at: "2026-05-30T11:00:00Z" },
  { campaign_id: "big", campaign_number_id: "n3", status: "no_answer", goal_reached: null, duration_seconds: null, created_at: "2026-05-29T10:00:00Z" },
  { campaign_id: "big", campaign_number_id: "n3", status: "completed", goal_reached: null, duration_seconds: 200, created_at: "2026-05-31T10:00:00Z" },
  { campaign_id: "big", campaign_number_id: "n4", status: "failed", goal_reached: null, duration_seconds: null, created_at: "2026-05-29T12:00:00Z" },
  { campaign_id: "thin", campaign_number_id: "n5", status: "completed", goal_reached: true, duration_seconds: 60, created_at: "2026-06-01T10:00:00Z" },
  { campaign_id: "thin", campaign_number_id: "n6", status: "no_answer", goal_reached: null, duration_seconds: null, created_at: "2026-06-01T10:00:00Z" },
  { campaign_id: "test", campaign_number_id: "n7", status: "completed", goal_reached: true, duration_seconds: 50, created_at: "2026-06-01T10:00:00Z" },
];

const sms: SmsRow[] = [
  { campaign_id: "big", status: "delivered", provider: "mobivate" },
  { campaign_id: "big", status: "failed", provider: "mobivate" },
  { campaign_id: "big", status: "undelivered", provider: "mobivate" },
  { campaign_id: "big", status: "queued", provider: "mobivate" },
  { campaign_id: "thin", status: "delivered", provider: "mobivate" },
];

export const FIXTURE_INPUT: AnalyticsInput = { campaigns, numbers, calls, sms, now: FIXTURE_NOW };
