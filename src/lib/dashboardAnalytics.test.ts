import { describe, it, expect } from "vitest";
import {
  computeKpis,
  rollup,
  filterCalls,
  buildCampaignIndex,
  computeCampaignRollups,
  computeAgentRollups,
  bestBySuccess,
  computeGlobalKpis,
  deriveDisplayStatus,
  computeCampaignTable,
  deriveRecordStatus,
  computeCallRecords,
  recordHasAttemptOutcome,
  deriveAttemptTag,
  promptLabel,
  representativeBaseBySha,
  computePromptRollups,
  computeTrend,
  computeDailyVolume,
  computeHeatmap,
  localDayHourInTimezone,
  computeToday,
  type DashCallRow,
  type DashCampaignRow,
  type DashSmsRow,
  type RateRow,
} from "./dashboardAnalytics";

function call(
  campaign_id: string,
  status: string,
  goal_reached: boolean | null,
  created_at: string,
  campaign_number_id?: string,
  voicemail?: boolean | null,
  duration_seconds?: number | null,
  ended_reason?: string | null,
  transcript?: string | null,
): DashCallRow {
  return { campaign_id, status, goal_reached, created_at, campaign_number_id, voicemail, duration_seconds, ended_reason, transcript };
}

function camp(id: string, over: Partial<DashCampaignRow> = {}): DashCampaignRow {
  return { id, name: `L7_XX_${id}_OFFER`, status: "running", ...over };
}

// N completed calls for a campaign, the first `goals` of them goal_reached.
function many(campaign_id: string, total: number, goals: number): DashCallRow[] {
  return Array.from({ length: total }, (_, i) =>
    call(campaign_id, "completed", i < goals, "2026-06-10T00:00:00Z"),
  );
}

describe("computeKpis — rate definitions", () => {
  it("Success% is off CONNECTED (not calls); connectRate denominator excludes in-flight", () => {
    const calls: DashCallRow[] = [
      call("c", "completed", true, "2026-06-10T00:00:00Z"),
      call("c", "completed", true, "2026-06-10T00:00:00Z"),
      call("c", "completed", false, "2026-06-10T00:00:00Z"),
      call("c", "completed", null, "2026-06-10T00:00:00Z"),
      call("c", "no_answer", false, "2026-06-10T00:00:00Z"),
      call("c", "busy", false, "2026-06-10T00:00:00Z"),
      call("c", "initiated", null, "2026-06-10T00:00:00Z"), // in-flight — excluded from terminal
      call("c", "queued", null, "2026-06-10T00:00:00Z"), // in-flight — excluded from terminal
    ];
    const k = computeKpis(calls);
    expect(k.calls).toBe(8);
    expect(k.connected).toBe(4); // 4 completed
    expect(k.terminal).toBe(6); // 4 completed + no_answer + busy (NOT initiated/queued)
    expect(k.successful).toBe(2); // goal_reached === true only
    expect(k.connectRate).toBeCloseTo(4 / 6, 6);
    expect(k.successRate).toBeCloseTo(2 / 4, 6); // off connected (4), NOT calls (8)
  });

  it("voicemail/reach: connected-gated, null-safe over evaluated; reach counts unevaluated as reached", () => {
    const calls: DashCallRow[] = [
      call("c", "completed", true, "2026-06-10T00:00:00Z", "n1", true), // voicemail
      call("c", "completed", false, "2026-06-10T00:00:00Z", "n2", true), // voicemail
      call("c", "completed", true, "2026-06-10T00:00:00Z", "n3", false), // human
      call("c", "completed", null, "2026-06-10T00:00:00Z", "n4", null), // connected, NOT evaluated
      call("c", "no_answer", false, "2026-06-10T00:00:00Z", "n5", true), // not connected — voicemail ignored
    ];
    const k = computeKpis(calls);
    expect(k.connected).toBe(4);
    expect(k.voicemailConnected).toBe(2); // 2 connected+voicemail (the no_answer is not connected)
    expect(k.voicemailEvaluated).toBe(3); // 3 connected with a non-null flag (n4 excluded)
    expect(k.voicemailRate).toBeCloseTo(2 / 3, 6); // voicemailConnected / voicemailEvaluated
    expect(k.reach).toBe(2); // connected(4) − voicemailConnected(2); n4 (unevaluated) counts as reached
  });

  it("voicemailRate is null when no connected call has been evaluated (forward-only)", () => {
    const k = computeKpis([call("c", "completed", true, "2026-06-10T00:00:00Z", "n1")]);
    expect(k.voicemailEvaluated).toBe(0);
    expect(k.voicemailRate).toBeNull();
    expect(k.reach).toBe(1); // unevaluated connect still counts as reached
  });

  it("returns null rates (never NaN) on empty input", () => {
    const k = computeKpis([]);
    expect(k.connectRate).toBeNull();
    expect(k.successRate).toBeNull();
  });
});

describe("rollup primitive", () => {
  it("buckets by key and drops null-key calls", () => {
    const calls: DashCallRow[] = [
      call("a", "completed", true, "2026-06-10T00:00:00Z"),
      call("a", "no_answer", false, "2026-06-10T00:00:00Z"),
      call("b", "completed", false, "2026-06-10T00:00:00Z"),
    ];
    const m = rollup(calls, (c) => (c.campaign_id === "b" ? null : c.campaign_id));
    expect([...m.keys()]).toEqual(["a"]); // 'b' dropped
    expect(m.get("a")!.connected).toBe(1);
  });
});

describe("filterCalls", () => {
  const campaigns: DashCampaignRow[] = [
    camp("A", { voice_id: "VA" }),
    camp("B", { voice_id: "VB" }),
    camp("G", { source: "ghost_portal", voice_id: "VG" }),
    camp("T", { is_test: true, voice_id: "VT" }),
  ];
  const index = buildCampaignIndex(campaigns);
  const all: DashCallRow[] = [
    call("A", "completed", true, "2026-06-10T10:00:00Z", "n1"),
    call("A", "completed", true, "2026-06-01T10:00:00Z", "n2"), // out of window
    call("B", "completed", false, "2026-06-10T10:00:00Z", "n3"),
    call("G", "completed", true, "2026-06-10T10:00:00Z", "n4"), // ghost
    call("T", "completed", true, "2026-06-10T10:00:00Z", "n5"), // test
  ];
  const base = {
    startMs: Date.parse("2026-06-05T00:00:00Z"),
    endMs: Date.parse("2026-06-15T00:00:00Z"),
  };

  it("drops ghost (always) and test (default), and out-of-window calls", () => {
    const out = filterCalls(all, base, index);
    expect(out.map((c) => c.campaign_number_id).sort()).toEqual(["n1", "n3"]);
  });
  it("includeTest keeps test-campaign calls", () => {
    const out = filterCalls(all, { ...base, includeTest: true }, index);
    expect(out.map((c) => c.campaign_number_id).sort()).toEqual(["n1", "n3", "n5"]);
  });
  it("campaignIds narrows to selected campaigns", () => {
    const out = filterCalls(all, { ...base, campaignIds: ["A"] }, index);
    expect(out.map((c) => c.campaign_number_id)).toEqual(["n1"]);
  });
  it("voiceId narrows to a single agent", () => {
    const out = filterCalls(all, { ...base, voiceId: "VB" }, index);
    expect(out.map((c) => c.campaign_number_id)).toEqual(["n3"]);
  });
  it("numberIds (phone lookup) narrows to matching campaign_number_ids", () => {
    const out = filterCalls(all, { ...base, numberIds: ["n1"] }, index);
    expect(out.map((c) => c.campaign_number_id)).toEqual(["n1"]);
  });
});

describe("computeCampaignRollups + computeAgentRollups", () => {
  const campaigns: DashCampaignRow[] = [
    camp("A", { voice_id: "V1", base_assistant_id: "base1", vapi_assistant_name: "Steven", campaign_type: "fixed" }),
    camp("B", { voice_id: "V1", base_assistant_id: "base1", vapi_assistant_name: "Steven", campaign_type: "recurring" }),
    camp("C", { voice_id: "V2", base_assistant_id: "base2", vapi_assistant_name: "Emma" }),
  ];
  const index = buildCampaignIndex(campaigns);
  const calls: DashCallRow[] = [
    call("A", "completed", true, "2026-06-10T00:00:00Z"),
    call("A", "completed", false, "2026-06-10T00:00:00Z"),
    call("B", "completed", true, "2026-06-10T00:00:00Z"),
    call("C", "no_answer", false, "2026-06-10T00:00:00Z"),
  ];

  it("per-campaign carries meta + correct rates", () => {
    const rows = computeCampaignRollups(calls, index);
    const a = rows.find((r) => r.id === "A")!;
    expect(a.connected).toBe(2);
    expect(a.successRate).toBeCloseTo(1 / 2, 6);
    expect(a.scheduleType).toBe("fixed");
    expect(a.agentLabel).toBe("Steven");
    expect(a.lastCallAtMs).toBe(Date.parse("2026-06-10T00:00:00Z"));
  });

  it("agent rollup groups campaigns sharing a BASE agent and counts them", () => {
    const agents = computeAgentRollups(calls, index);
    const a1 = agents.find((a) => a.baseAssistantId === "base1")!;
    expect(a1.calls).toBe(3); // A(2) + B(1)
    expect(a1.connected).toBe(3);
    expect(a1.successful).toBe(2);
    expect(a1.campaignCount).toBe(2);
  });
});

describe("bestBySuccess — min-volume guard", () => {
  const mk = (connected: number, successRate: number, calls: number): RateRow & { id: string } => ({
    id: `r${connected}`,
    calls,
    connected,
    terminal: connected,
    successful: Math.round(connected * successRate),
    connectRate: 1,
    successRate,
    voicemailConnected: 0,
    voicemailEvaluated: 0,
    reach: connected,
    voicemailRate: null,
  });
  it("ignores below-floor rows so a 1-2 call 100% can't win", () => {
    const rows = [mk(20, 0.1, 100), mk(5, 1.0, 5)];
    const best = bestBySuccess(rows, (r) => ({ key: r.id, label: r.id }));
    expect(best?.successRate).toBeCloseTo(0.1, 6);
    expect(best?.calls).toBe(100);
  });
  it("returns null when nothing meets the floor", () => {
    const rows = [mk(3, 1.0, 3)];
    expect(bestBySuccess(rows, (r) => ({ key: r.id, label: r.id }))).toBeNull();
  });
});

describe("computeToday — always-live snapshot", () => {
  const now = Date.parse("2026-06-15T12:00:00.000Z");
  const campaigns: DashCampaignRow[] = [
    camp("c1", { status: "running", voice_id: "v1", vapi_assistant_name: "Steven" }),
    camp("c2", { status: "running", voice_id: "v1", vapi_assistant_name: "Steven" }), // shares v1
    camp("c3", { status: "running", voice_id: "v2", vapi_assistant_name: "Emma" }),
    camp("c4", { status: "paused", voice_id: "v3", vapi_assistant_name: "Liam" }),
    camp("cG", { status: "running", voice_id: "vG", source: "ghost_portal" }),
    camp("cT", { status: "running", voice_id: "vT", is_test: true }),
  ];
  const calls: DashCallRow[] = [
    // today (>= 06-15T00Z) — voicemail flags: c1=VM, c2=human, c3=unevaluated(null)
    call("c1", "completed", true, "2026-06-15T09:00:00Z", "n1", true),
    call("c1", "no_answer", false, "2026-06-15T09:05:00Z"),
    call("c2", "completed", false, "2026-06-15T10:00:00Z", "n2", false),
    call("c3", "completed", true, "2026-06-15T11:00:00Z", "n3", null),
    call("cG", "completed", true, "2026-06-15T08:00:00Z"), // ghost — excluded
    call("cT", "completed", true, "2026-06-15T08:30:00Z"), // test — excluded
    // yesterday (also inside the prior-7d window)
    call("c1", "completed", true, "2026-06-14T10:00:00Z"),
    // 6 more inside prior-7d window (06-12) => 7 total in window => avg 1.0/day
    call("c1", "completed", false, "2026-06-12T10:00:00Z"),
    call("c1", "completed", false, "2026-06-12T10:01:00Z"),
    call("c1", "completed", false, "2026-06-12T10:02:00Z"),
    call("c1", "completed", false, "2026-06-12T10:03:00Z"),
    call("c1", "completed", false, "2026-06-12T10:04:00Z"),
    call("c1", "completed", false, "2026-06-12T10:05:00Z"),
  ];
  const sms: DashSmsRow[] = [
    { campaign_id: "c1", created_at: "2026-06-15T09:01:00Z", status: "sent" },
    { campaign_id: "c2", created_at: "2026-06-15T10:01:00Z", status: "delivered" },
    { campaign_id: "cG", created_at: "2026-06-15T08:01:00Z", status: "sent" }, // ghost — excluded
    { campaign_id: "c1", created_at: "2026-06-15T09:02:00Z", status: "queued" }, // not sent/delivered — excluded
  ];

  const snap = computeToday(calls, campaigns, sms, now);

  it("counts today's LIVE calls only (ghost + test excluded)", () => {
    expect(snap.ops.callsToday).toBe(4);
    expect(snap.ops.callsYesterday).toBe(1);
  });
  it("deltas vs yesterday and vs 7-day avg", () => {
    expect(snap.ops.sevenDayAvg).toBeCloseTo(1, 6); // 7 calls in the prior-7d window / 7
    expect(snap.ops.deltaVsYesterday).toBeCloseTo(3, 6); // (4-1)/1
    expect(snap.ops.deltaVsSevenDayAvg).toBeCloseTo(3, 6); // (4-1)/1
  });
  it("today connect rate uses terminal denominator", () => {
    expect(snap.ops.connectedToday).toBe(3);
    expect(snap.ops.terminalToday).toBe(4);
    expect(snap.ops.connectRateToday).toBeCloseTo(3 / 4, 6);
  });
  it("today reach + voicemail-rate (connected-gated, null-safe)", () => {
    // 3 connected today: c1(VM), c2(human), c3(unevaluated)
    expect(snap.ops.voicemailConnectedToday).toBe(1); // c1
    expect(snap.ops.voicemailEvaluatedToday).toBe(2); // c1(true) + c2(false); c3(null) excluded
    expect(snap.ops.voicemailRateToday).toBeCloseTo(1 / 2, 6);
    expect(snap.ops.reachToday).toBe(2); // connected(3) − voicemail(1); c3 unevaluated counts as reached
  });
  it("messages sent today + shares (sent/delivered only, ghost excluded)", () => {
    expect(snap.ops.messagesSentToday).toBe(2);
    expect(snap.ops.messagesShareOfCalls).toBeCloseTo(2 / 4, 6);
    expect(snap.ops.messagesShareOfConnected).toBeCloseTo(2 / 3, 6);
  });
  it("active/total/idle agents + running count (shared voice counted once; paused idle)", () => {
    expect(snap.ops.activeAgents).toBe(2); // {v1, v2} among running live
    expect(snap.ops.totalAgents).toBe(3); // {v1, v2, v3} among all live
    expect(snap.ops.idleAgents).toBe(1); // v3 (paused c4)
    expect(snap.ops.runningCampaignCount).toBe(3); // c1, c2, c3 (ghost/test excluded)
  });
  it("running campaign cards carry today's per-campaign rate", () => {
    expect(snap.runningCampaigns).toHaveLength(3);
    const c1 = snap.runningCampaigns.find((r) => r.id === "c1")!;
    expect(c1.today.calls).toBe(2);
    expect(c1.today.connected).toBe(1);
    expect(c1.today.successful).toBe(1);
  });
});

describe("computeGlobalKpis", () => {
  const campaigns = [
    camp("A", { voice_id: "V1", base_assistant_id: "base1", vapi_assistant_name: "Steven" }),
    camp("B", { voice_id: "V1", base_assistant_id: "base1", vapi_assistant_name: "Steven" }), // shares base1
    camp("C", { voice_id: "V2", base_assistant_id: "base2", vapi_assistant_name: "Emma" }),
  ];
  const index = buildCampaignIndex(campaigns);
  // A: 12 connected / 6 goal (0.50); B: 11 / 1 (~0.09); C: 10 / 0 (0.00). All above the floor (10).
  const calls = [...many("A", 12, 6), ...many("B", 11, 1), ...many("C", 10, 0)];
  const g = computeGlobalKpis(calls, index);

  it("KPIs off connected + distinct campaign count", () => {
    expect(g.kpis.calls).toBe(33);
    expect(g.kpis.connected).toBe(33);
    expect(g.kpis.successful).toBe(7);
    expect(g.kpis.successRate).toBeCloseTo(7 / 33, 6);
    expect(g.campaignCount).toBe(3);
  });

  it("best campaign + best agent ranked by success (floor-gated)", () => {
    expect(g.bestCampaign?.key).toBe("A");
    expect(g.bestCampaign?.successRate).toBeCloseTo(0.5, 6);
    // base1 = A+B (7/23 ≈ 0.30) beats base2 = C (0/10). key = base_assistant_id; the UI resolves the name.
    expect(g.bestAgent?.key).toBe("base1");
    expect(g.bestAgent?.label).toBe("base1");
    expect(g.bestAgent?.successRate).toBeCloseTo(7 / 23, 6);
  });
});

describe("deriveDisplayStatus (the 'Ended' rule)", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const day = 86_400_000;
  it("trusts a live running status (even past end_at)", () => {
    expect(deriveDisplayStatus({ rawStatus: "running", endAtMs: now - day, lastCallMs: now, nowMs: now })).toBe("running");
  });
  it("paused past its scheduled end_at → completed", () => {
    expect(deriveDisplayStatus({ rawStatus: "paused", endAtMs: now - day, lastCallMs: now - 2 * day, nowMs: now })).toBe("completed");
  });
  it("paused & idle ≥ 7 days → ended", () => {
    expect(deriveDisplayStatus({ rawStatus: "paused", endAtMs: null, lastCallMs: now - 10 * day, nowMs: now })).toBe("ended");
  });
  it("paused & never dialed → ended", () => {
    expect(deriveDisplayStatus({ rawStatus: "paused", endAtMs: null, lastCallMs: null, nowMs: now })).toBe("ended");
  });
  it("paused with recent activity → paused", () => {
    expect(deriveDisplayStatus({ rawStatus: "paused", endAtMs: null, lastCallMs: now - 2 * day, nowMs: now })).toBe("paused");
  });
  it("completed / inactive / draft pass through", () => {
    expect(deriveDisplayStatus({ rawStatus: "completed", endAtMs: null, lastCallMs: null, nowMs: now })).toBe("completed");
    expect(deriveDisplayStatus({ rawStatus: "inactive", endAtMs: null, lastCallMs: null, nowMs: now })).toBe("inactive");
    expect(deriveDisplayStatus({ rawStatus: "draft", endAtMs: null, lastCallMs: null, nowMs: now })).toBe("inactive");
  });
});

describe("computeCampaignTable", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const campaigns = [
    camp("c1", { status: "running", voice_id: "v1" }),
    camp("c2", { status: "paused", voice_id: "v1" }),
    camp("c3", { status: "paused", voice_id: "v2" }),
    camp("c4", { status: "paused", voice_id: "v3" }), // zero calls in window
    camp("cG", { status: "paused", source: "ghost_portal" }),
    camp("cT", { status: "paused", is_test: true }),
  ];
  const calls = [
    call("c1", "completed", true, iso(now - 1 * day)),
    call("c2", "completed", false, iso(now - 10 * day)),
    call("c3", "completed", false, iso(now - 2 * day)),
    call("cG", "completed", true, iso(now - 1 * day)), // ghost — excluded
    call("cT", "completed", true, iso(now - 1 * day)), // test — excluded
  ];
  const rows = computeCampaignTable(calls, campaigns, now);

  it("returns all live campaigns incl. zero-call ones; excludes ghost + test", () => {
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "c2", "c3", "c4"]);
    expect(rows.find((r) => r.id === "c4")!.calls).toBe(0);
  });

  it("derives display status per row (running / ended / paused)", () => {
    const by = Object.fromEntries(rows.map((r) => [r.id, r.displayStatus]));
    expect(by.c1).toBe("running");
    expect(by.c2).toBe("ended"); // paused, idle 10d
    expect(by.c3).toBe("paused"); // paused, idle 2d
    expect(by.c4).toBe("ended"); // paused, no calls
  });

  it("players/smsSent default to 0 when no numbers/sms passed", () => {
    expect(rows.find((r) => r.id === "c1")!.players).toBe(0);
    expect(rows.find((r) => r.id === "c1")!.smsSent).toBe(0);
  });

  it("counts players (roster), reach (human connects), SMS sent (all dispatched incl. failed)", () => {
    const c = [
      call("p1", "completed", true, iso(now - 1 * day), "n1", false), // reached human
      call("p1", "completed", false, iso(now - 1 * day), "n2", true), // voicemail → not reach
    ];
    const camps = [camp("p1", { status: "running" })];
    const numbers = [{ campaign_id: "p1" }, { campaign_id: "p1" }, { campaign_id: "p1" }]; // 3-strong roster
    const sms = [
      { campaign_id: "p1", status: "delivered" },
      { campaign_id: "p1", status: "sent" },
      { campaign_id: "p1", status: "queued" },
      { campaign_id: "p1", status: "failed" }, // dispatched → counted
      { campaign_id: "p1", status: "undelivered" }, // dispatched → counted
    ];
    const r = computeCampaignTable(c, camps, now, 7, numbers, sms).find((x) => x.id === "p1")!;
    expect(r.players).toBe(3);
    expect(r.connected).toBe(2);
    expect(r.reach).toBe(1); // 2 connected − 1 voicemail
    expect(r.smsSent).toBe(5); // every dispatched message (delivered + in-flight + failed/undelivered)
  });
});

describe("call records", () => {
  it("deriveRecordStatus maps outcomes (goal wins; voicemail/wrong_number underivable here)", () => {
    expect(deriveRecordStatus("not_interested", false)).toBe("not_interested");
    expect(deriveRecordStatus("declined_offer", false)).toBe("not_interested");
    expect(deriveRecordStatus("pending_retry", false)).toBe("awaiting_retry");
    expect(deriveRecordStatus("unreached", false)).toBe("unreached");
    expect(deriveRecordStatus("sent_sms", false)).toBe("successful");
    expect(deriveRecordStatus("sms_delivered", false)).toBe("successful"); // offer delivered by SMS (voicemail follow-up) = success
    expect(deriveRecordStatus("wrong_number", false)).toBe("wrong_number");
    expect(deriveRecordStatus("not_interested", true)).toBe("successful"); // a goal overrides
    expect(deriveRecordStatus(null, false)).toBe("unreached");
  });

  it("computeCallRecords derives per-attempt tags (ordered asc) + a funnel-furthest contact tag", () => {
    const numbers = [
      { id: "n1", phone_e164: "+1", outcome: "completed" }, // no_answer then completed+goal
      { id: "n2", phone_e164: "+2", outcome: "declined_offer" }, // declined contact
      { id: "n3", phone_e164: "+3", outcome: "completed" }, // early hangup (8s)
      { id: "n4", phone_e164: "+4", outcome: "completed" }, // voicemail
      { id: "n5", phone_e164: "+5", outcome: "pending" }, // never dialed
    ];
    const calls = [
      // n1: attempt 1 = no_answer (unreachable), attempt 2 = completed+goal (positive)
      call("x", "no_answer", false, "2026-06-09T10:00:00Z", "n1"),
      call("x", "completed", true, "2026-06-11T10:00:00Z", "n1"),
      // n2: completed call, no goal, contact outcome declined_offer → declined
      call("x", "completed", false, "2026-06-10T10:00:00Z", "n2"),
      // n3: completed, short duration, no goal/decline → early_hangup
      call("x", "completed", false, "2026-06-10T10:00:00Z", "n3", null, 8),
      // n4: completed, voicemail true → voicemail
      call("x", "completed", false, "2026-06-10T10:00:00Z", "n4", true),
    ];
    const recs = computeCallRecords(numbers, calls);

    const r1 = recs.find((r) => r.campaignNumberId === "n1")!;
    expect(r1.attempts).toHaveLength(2);
    expect(r1.attempts[0]).toMatchObject({ index: 1, tag: "unreachable" }); // earliest first
    expect(r1.attempts[1]).toMatchObject({ index: 2, tag: "positive" });
    expect(r1.tag).toBe("positive"); // funnel-furthest OUTCOME
    expect(r1.status).toBe("successful"); // DISPOSITION: a goal on any attempt wins
    expect(r1.lastAttemptedMs).toBe(Date.parse("2026-06-11T10:00:00Z"));

    const r2 = recs.find((r) => r.campaignNumberId === "n2")!;
    expect(r2.attempts[0].tag).toBe("declined");
    expect(r2.tag).toBe("declined"); // OUTCOME
    expect(r2.status).toBe("not_interested"); // DISPOSITION ≠ outcome: declined_offer → status not_interested

    const r3 = recs.find((r) => r.campaignNumberId === "n3")!;
    expect(r3.attempts[0].tag).toBe("early_hangup");
    expect(r3.tag).toBe("early_hangup");

    const r4 = recs.find((r) => r.campaignNumberId === "n4")!;
    expect(r4.attempts[0].tag).toBe("voicemail");
    expect(r4.tag).toBe("voicemail");

    const r5 = recs.find((r) => r.campaignNumberId === "n5")!;
    expect(r5.attempts).toEqual([]); // never dialed
    expect(r5.tag).toBe("awaiting_retry"); // pending outcome, no calls
    expect(r5.status).toBe("awaiting_retry"); // disposition: pending → awaiting retry
    expect(r5.lastAttemptedMs).toBeNull();
  });

  it("recordHasAttemptOutcome matches when ANY attempt carries the tag", () => {
    // n1: attempt 1 = no_answer (unreachable), attempt 2 = completed+goal (positive)
    const numbers = [{ id: "n1", phone_e164: "+1", outcome: "completed" }];
    const calls = [
      call("x", "no_answer", false, "2026-06-09T10:00:00Z", "n1"),
      call("x", "completed", true, "2026-06-11T10:00:00Z", "n1"),
    ];
    const [rec] = computeCallRecords(numbers, calls);
    expect(rec.attempts.map((a) => a.tag)).toEqual(["unreachable", "positive"]);
    // per-attempt filter semantics: a record matches EITHER of its attempt tags
    expect(recordHasAttemptOutcome(rec, "unreachable")).toBe(true);
    expect(recordHasAttemptOutcome(rec, "positive")).toBe(true);
    // a tag no attempt carries → no match
    expect(recordHasAttemptOutcome(rec, "voicemail")).toBe(false);
  });

  it("recordHasAttemptOutcome returns false for a never-dialed contact (no attempts)", () => {
    const numbers = [{ id: "n5", phone_e164: "+5", outcome: "pending" }];
    const [rec] = computeCallRecords(numbers, []);
    expect(rec.attempts).toEqual([]);
    // a zero-attempt contact matches NO attempt-outcome filter (documented behavior change
    // vs the old contact-rollup filter, which would have matched on r.tag)
    expect(recordHasAttemptOutcome(rec, "unreachable")).toBe(false);
    expect(recordHasAttemptOutcome(rec, "positive")).toBe(false);
  });
});

describe("deriveAttemptTag — engagement rules (real-data cases)", () => {
  // attempt 1 (prod +61474932636): completed, empty transcript, dur 23s → early hangup (no real conversation)
  it("tags a connected call with 0 substantive customer turns as early_hangup", () => {
    const c = call("x", "completed", null, "2026-06-26T08:39:07Z", "n1", null, 23, null, "");
    expect(deriveAttemptTag(c, false)).toBe("early_hangup");
  });
  // attempt 2 (prod): customer "Hello?" then customer-ended-call, dur 30s → early hangup (pickup-and-bail)
  it("tags a customer-ended-call with <=1 customer turn as early_hangup regardless of duration", () => {
    const c = call("x", "completed", false, "2026-06-26T10:15:20Z", "n2", false, 30, "customer-ended-call", "User: Hello?\nAI: Hey. Victor here from Lucky seven.");
    expect(deriveAttemptTag(c, false)).toBe("early_hangup");
  });
  // a REAL multi-turn conversation the customer ends → stays neutral (no false positive)
  it("keeps a multi-turn customer-ended-call as neutral", () => {
    const c = call("x", "completed", false, "2026-06-26T10:00:00Z", "n3", false, 40, "customer-ended-call", "AI: Hi\nUser: yeah what is this\nAI: an offer\nUser: not right now thanks");
    expect(deriveAttemptTag(c, false)).toBe("neutral");
  });
  // voicemail still wins over the engagement rules
  it("tags voicemail before engagement", () => {
    const c = call("x", "completed", false, "2026-06-26T10:15:21Z", "n4", true, 20, "assistant-ended-call", "User: You have reached the message bank of...");
    expect(deriveAttemptTag(c, false)).toBe("voicemail");
  });
  // accepts the jsonb {text} shape straight from the DB
  it("normalizes the jsonb {text} transcript shape", () => {
    const c: DashCallRow = { campaign_id: "x", status: "completed", goal_reached: false, created_at: "2026-06-26T08:00:00Z", transcript: { text: "" } };
    expect(deriveAttemptTag(c, false)).toBe("early_hangup");
  });
  // a goal-reached call stays positive even with a thin transcript (rule order)
  it("keeps goal_reached as positive ahead of engagement", () => {
    const c = call("x", "completed", true, "2026-06-26T10:00:00Z", "n5", false, 30, "customer-ended-call", "User: yes");
    expect(deriveAttemptTag(c, false)).toBe("positive");
  });
});

describe("prompt rollups", () => {
  it("promptLabel = snippet (+ ellipsis when long) + 4-char sha", () => {
    expect(promptLabel("Short prompt", "abcd1234")).toBe("Short prompt · abcd");
    expect(promptLabel("x".repeat(250), "ef005678")).toBe(`${"x".repeat(200)}… · ef00`);
  });

  it("promptLabel strips the platform prefix up to [End System Instructions] (drift-tolerant de-boilerplate)", () => {
    // Real prompts vary in prefix length (drift), but the [End System Instructions] marker is stable.
    const prefixed =
      "[System Instructions — Voizo Platform]\nany rules, any length…\n[End System Instructions]\n\n[Identity]\nYou are Tom, a friendly sales agent for L7 Casino calling about a deposit match.";
    const operator = "[Identity] You are Tom, a friendly sales agent for L7 Casino calling about a deposit match.";
    expect(promptLabel(prefixed, "e5731234")).toBe(`${operator} · e573`); // < cap → no ellipsis
  });

  it("promptLabel leaves prefix-less operator text untouched (no marker present)", () => {
    const agent = "You are Lara, a retention specialist.";
    expect(promptLabel(agent, "9f1c0000")).toBe(`${agent} · 9f1c`);
  });

  it("representativeBaseBySha maps each sha to the first non-null base agent id (null when all null)", () => {
    const m = new Map([
      ["A", { sha: "shaX", label: "x", baseAssistantId: null }],
      ["B", { sha: "shaX", label: "x", baseAssistantId: "base-1" }], // first non-null wins for shaX
      ["C", { sha: "shaX", label: "x", baseAssistantId: "base-2" }], // ignored (already resolved)
      ["D", { sha: "shaY", label: "y", baseAssistantId: null }], // all null → null
    ]);
    const out = representativeBaseBySha(m);
    expect(out.get("shaX")).toBe("base-1");
    expect(out.get("shaY")).toBeNull();
  });

  it("computePromptRollups attaches the representative base agent id per prompt", () => {
    const promptByCampaign = new Map([
      ["A", { sha: "shaX", label: "X · shaX", baseAssistantId: "base-1" }],
      ["B", { sha: "shaX", label: "X · shaX", baseAssistantId: "base-1" }],
    ]);
    const calls = [call("A", "completed", true, "2026-06-10T00:00:00Z")];
    const rows = computePromptRollups(calls, promptByCampaign);
    expect(rows.find((r) => r.sha === "shaX")!.baseAssistantId).toBe("base-1");
  });

  it("groups calls by the campaign's prompt content hash", () => {
    const promptByCampaign = new Map([
      ["A", { sha: "shaX", label: "X · shaX" }],
      ["B", { sha: "shaX", label: "X · shaX" }], // shares prompt with A
      ["C", { sha: "shaY", label: "Y · shaY" }],
    ]);
    const calls = [
      call("A", "completed", true, "2026-06-10T00:00:00Z"),
      call("A", "completed", false, "2026-06-10T00:00:00Z"),
      call("B", "completed", true, "2026-06-10T00:00:00Z"),
      call("C", "no_answer", false, "2026-06-10T00:00:00Z"),
    ];
    const rows = computePromptRollups(calls, promptByCampaign);
    const x = rows.find((r) => r.sha === "shaX")!;
    expect(x.calls).toBe(3); // A(2) + B(1)
    expect(x.connected).toBe(3);
    expect(x.successful).toBe(2);
    expect(x.successRate).toBeCloseTo(2 / 3, 6);
    expect(x.campaignCount).toBe(2);
    const y = rows.find((r) => r.sha === "shaY")!;
    expect(y.connected).toBe(0); // no_answer
  });
});

describe("computeTrend", () => {
  it("zero-fills the day range + computes per-day connect/success", () => {
    const start = Date.parse("2026-06-10T00:00:00Z");
    const end = Date.parse("2026-06-12T12:00:00Z");
    const calls = [
      call("c", "completed", true, "2026-06-11T09:00:00Z"),
      call("c", "completed", false, "2026-06-11T10:00:00Z"),
      call("c", "no_answer", false, "2026-06-11T11:00:00Z"),
    ];
    const t = computeTrend(calls, start, end);
    expect(t.map((p) => p.day)).toEqual(["2026-06-10", "2026-06-11", "2026-06-12"]);
    expect(t[0].calls).toBe(0);
    expect(t[0].connectRate).toBeNull();
    expect(t[1].calls).toBe(3);
    expect(t[1].connectRate).toBeCloseTo(2 / 3, 6); // 2 completed / 3 terminal
    expect(t[1].successRate).toBeCloseTo(1 / 2, 6); // 1 goal / 2 connected
  });
});

describe("computeDailyVolume", () => {
  it("buckets per day, caps to topN with an Other bucket", () => {
    const campaigns = [camp("A"), camp("B"), camp("C")];
    const calls = [
      call("A", "completed", true, "2026-06-10T01:00:00Z"),
      call("A", "completed", true, "2026-06-10T02:00:00Z"),
      call("A", "completed", true, "2026-06-10T03:00:00Z"),
      call("B", "completed", true, "2026-06-10T04:00:00Z"),
      call("B", "completed", true, "2026-06-10T05:00:00Z"),
      call("C", "completed", true, "2026-06-11T01:00:00Z"),
    ];
    const v = computeDailyVolume(calls, campaigns, Date.parse("2026-06-10T00:00:00Z"), Date.parse("2026-06-11T12:00:00Z"), 2);
    expect(v.series.map((s) => s.key)).toEqual(["A", "B", "other"]); // C folds into Other
    expect(v.days.map((d) => d.day)).toEqual(["2026-06-10", "2026-06-11"]);
    expect(v.days[0].A).toBe(3);
    expect(v.days[0].B).toBe(2);
    expect(v.days[1].other).toBe(1);
  });
});

describe("localDayHourInTimezone", () => {
  it("returns the local civil day + hour for a valid IANA timezone", () => {
    // 2026-06-10T23:30Z in Sydney (AEST, UTC+10 in June) → 2026-06-11 09:30 local
    expect(localDayHourInTimezone(new Date("2026-06-10T23:30:00Z"), "Australia/Sydney")).toEqual({ day: "2026-06-11", hour: 9 });
    // 2026-06-10T01:30Z in Toronto (EDT, UTC-4 in June) → 2026-06-09 21:30 local
    expect(localDayHourInTimezone(new Date("2026-06-10T01:30:00Z"), "America/Toronto")).toEqual({ day: "2026-06-09", hour: 21 });
  });

  it("returns null for an invalid or empty timezone (caller falls back to UTC)", () => {
    expect(localDayHourInTimezone(new Date("2026-06-10T12:00:00Z"), "Not/AZone")).toBeNull();
    expect(localDayHourInTimezone(new Date("2026-06-10T12:00:00Z"), "")).toBeNull();
  });
});

describe("computeHeatmap", () => {
  it("buckets by date×hour with per-slot totals + breakdown (UTC when no campaign timezone)", () => {
    const campaigns = [camp("A"), camp("B")]; // no timezone → UTC fallback
    const calls = [
      call("A", "completed", true, "2026-06-10T09:15:00Z"),
      call("A", "no_answer", false, "2026-06-10T09:45:00Z"),
      call("B", "completed", false, "2026-06-10T09:30:00Z"),
      call("A", "completed", true, "2026-06-10T10:05:00Z"),
    ];
    const { cells, localizedCalls, utcFallbackCalls } = computeHeatmap(calls, campaigns);
    const c9 = cells.find((x) => x.day === "2026-06-10" && x.hour === 9)!;
    expect(c9.calls).toBe(3);
    expect(c9.connected).toBe(2); // A completed + B completed
    expect(c9.successful).toBe(1); // A goal
    expect(c9.breakdown[0].calls).toBe(2); // A (2 in slot) sorts first
    const c10 = cells.find((x) => x.day === "2026-06-10" && x.hour === 10)!;
    expect(c10.calls).toBe(1);
    expect(localizedCalls).toBe(0); // no campaign had a timezone
    expect(utcFallbackCalls).toBe(4);
  });

  it("buckets each call by ITS campaign's local hour/day; counts UTC fallbacks", () => {
    const campaigns = [camp("A", { timezone: "Australia/Sydney" }), camp("B")]; // B has no tz
    const calls = [
      call("A", "completed", true, "2026-06-10T23:30:00Z"), // Sydney → 2026-06-11 09:30
      call("B", "completed", true, "2026-06-10T23:30:00Z"), // no tz → UTC 2026-06-10 23
    ];
    const { cells, localizedCalls, utcFallbackCalls } = computeHeatmap(calls, campaigns);
    expect(cells.find((x) => x.day === "2026-06-11" && x.hour === 9)?.calls).toBe(1); // localized A
    expect(cells.find((x) => x.day === "2026-06-10" && x.hour === 23)?.calls).toBe(1); // UTC B
    expect(localizedCalls).toBe(1);
    expect(utcFallbackCalls).toBe(1);
  });
});
