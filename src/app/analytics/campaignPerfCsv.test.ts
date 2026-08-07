import { describe, expect, it } from "vitest";
import { buildCampaignPerfCsv, type ExportableCampaignRow } from "./campaignPerfCsv";
import type { CallRollupRow, SmsRollupRow } from "../../lib/dashboardAnalytics";

const call = (campaign_id: string, day_utc: string, over: Partial<CallRollupRow> = {}): CallRollupRow => ({
  campaign_id, day_utc,
  attempts: 10, terminal: 10, connected: 4, voicemail: 1, reach: 3,
  positive: 1, declined: 0, early_hangup_lean: 1, neutral_lean: 1,
  successful: 1, voicemail_evaluated: 4, last_call_at: `${day_utc}T12:00:00Z`,
  ...over,
});
const sms = (campaign_id: string, day_utc: string, over: Partial<SmsRollupRow> = {}): SmsRollupRow => ({
  campaign_id, day_utc, sent: 3, reached: 2, voicemail: 1, unreachable: 0,
  positive: 1, neutral: 1, declined: 0,
  ...over,
});
const rowOf = (id: string, over: Partial<ExportableCampaignRow> = {}): ExportableCampaignRow => ({
  id, name: `Camp ${id}`, country: "Australia", cioWorkspace: "fortuneplay",
  displayStatus: "finished", scheduleType: "fixed", players: 50,
  startAt: "2026-08-01T00:00:00Z", lastCallAt: "2026-08-01T10:00:00Z",
  scriptName: "Reactivation v2", segmentId: "seg-1",
  ...over,
});

describe("buildCampaignPerfCsv — mass export (Val 2026-08-07)", () => {
  const D1 = "2026-08-01";
  const D2 = "2026-08-02";
  const argsBase = {
    callRollup: [call("a", D1), call("a", D2), call("b", D1)],
    smsRollup: [sms("a", D1), sms("b", D1)],
    brandLabelOf: () => "Fortune Play",
    agentLabelOf: () => "Val - Voice Agent",
  };

  it("one row per campaign + TOTAL; TOTAL equals the sum of the rows", () => {
    const csv = buildCampaignPerfCsv({ ...argsBase, rows: [rowOf("a"), rowOf("b")], fromMs: null, toMs: null });
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    expect(lines).toHaveLength(4); // header + a + b + TOTAL
    expect(lines[0]).toContain('"campaign"');
    // campaign a: two days × attempts 10 = 20; campaign b: 10; TOTAL 30.
    const cells = (l: string) => l.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const attemptsIdx = cells(lines[0]).indexOf("callAttempts");
    expect(cells(lines[1])[attemptsIdx]).toBe("20");
    expect(cells(lines[2])[attemptsIdx]).toBe("10");
    expect(cells(lines[3])[attemptsIdx]).toBe("30");
    expect(cells(lines[3])[0]).toBe("TOTAL (2 campaigns)");
  });

  it("windows metrics by [fromMs, toMs] like the summary block", () => {
    const csv = buildCampaignPerfCsv({
      ...argsBase, rows: [rowOf("a")],
      fromMs: Date.UTC(2026, 7, 2), toMs: Date.UTC(2026, 7, 2) + 86_400_000 - 1, // Aug 2 only
    });
    const lines = csv.replace(/^﻿/, "").split("\r\n");
    const cells = (l: string) => l.split(",").map((c) => c.replace(/^"|"$/g, ""));
    const attemptsIdx = cells(lines[0]).indexOf("callAttempts");
    expect(cells(lines[1])[attemptsIdx]).toBe("10"); // only the Aug-2 day counts
    const smsIdx = cells(lines[0]).indexOf("smsSent");
    expect(cells(lines[1])[smsIdx]).toBe("0"); // a's sms row is Aug 1 — outside the window
  });

  it("guards CSV formula injection on identity cells", () => {
    const csv = buildCampaignPerfCsv({
      ...argsBase,
      rows: [rowOf("a", { name: "=HYPERLINK(evil)", scriptName: "+SUM(1)" })],
      fromMs: null, toMs: null,
    });
    expect(csv).toContain("\"'=HYPERLINK(evil)\"");
    expect(csv).toContain("\"'+SUM(1)\"");
  });
});
