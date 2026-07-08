import { describe, it, expect } from "vitest";
import { parseRecordsParams, filterRecordsBySlice, paginate, FULL_SET_CAP } from "./rangedRecords";
import type { CallRecord } from "./dashboardAnalytics";

const rec = (id: string, over: Partial<CallRecord> = {}): CallRecord => ({
  campaignNumberId: id,
  phone: `+44${id}`,
  status: "unreached",
  tag: "unreachable",
  attempts: [],
  lastAttemptedMs: 0,
  ...over,
});

describe("parseRecordsParams — Zero-Trust validation", () => {
  it("clamps limit to [1,200] and offset to >=0; defaults sane", () => {
    const p = parseRecordsParams(new URLSearchParams("limit=9999&offset=-5"));
    expect(p.limit).toBe(200);
    expect(p.offset).toBe(0);
    expect(p.range).toBe("30d");
    expect(p.status).toBe("all");
    expect(p.outcome).toBe("all");
    expect(p.smsOnly).toBe(false);
    expect(p.full).toBe(false);
  });
  it("whitelists range/status/outcome, rejecting junk to defaults", () => {
    const p = parseRecordsParams(new URLSearchParams("range=999d&status=evil&outcome=drop"));
    expect(p.range).toBe("30d");
    expect(p.status).toBe("all");
    expect(p.outcome).toBe("all");
  });
  it("accepts a valid slice and the full-set flag (limit=all → capped)", () => {
    const p = parseRecordsParams(
      new URLSearchParams("range=90d&status=successful&outcome=positive&smsOnly=true&limit=all"),
    );
    expect(p.range).toBe("90d");
    expect(p.status).toBe("successful");
    expect(p.outcome).toBe("positive");
    expect(p.smsOnly).toBe(true);
    expect(p.full).toBe(true);
    expect(p.limit).toBe(FULL_SET_CAP);
  });
  it("whitelists lifetime and passes custom from/to through", () => {
    expect(parseRecordsParams(new URLSearchParams("range=lifetime")).range).toBe("lifetime");
    const custom = parseRecordsParams(new URLSearchParams("from=2026-06-01&to=2026-06-10"));
    expect(custom.from).toBe("2026-06-01");
    expect(custom.to).toBe("2026-06-10");
  });
  it("parses campaigns into a bounded id list and the reached outcome", () => {
    const p = parseRecordsParams(new URLSearchParams("campaigns=a,b,,c&outcome=reached"));
    expect(p.campaignIds).toEqual(["a", "b", "c"]);
    expect(p.outcome).toBe("reached");
  });
  it("parses + clamps baseAgent (Top Performers agent drill, Slice E)", () => {
    expect(parseRecordsParams(new URLSearchParams("baseAgent=agent-xyz")).baseAgent).toBe("agent-xyz");
    expect(parseRecordsParams(new URLSearchParams("")).baseAgent).toBeNull();
    expect(parseRecordsParams(new URLSearchParams(`baseAgent=${"x".repeat(200)}`)).baseAgent!.length).toBe(80);
  });
});

describe("filterRecordsBySlice", () => {
  const reached = rec("a", { tag: "neutral", attempts: [{ index: 1, tag: "neutral", atMs: 1 }] });
  const vm = rec("b", { tag: "voicemail", attempts: [{ index: 1, tag: "voicemail", atMs: 1 }] });
  const recs = [reached, vm];
  it("filters by the reached (human) outcome group", () => {
    const out = filterRecordsBySlice(recs, { status: "all", outcome: "reached", smsOnly: false }, new Set());
    expect(out.map((r) => r.campaignNumberId)).toEqual(["a"]);
  });
  it("filters by a specific attempt outcome", () => {
    const out = filterRecordsBySlice(recs, { status: "all", outcome: "voicemail", smsOnly: false }, new Set());
    expect(out.map((r) => r.campaignNumberId)).toEqual(["b"]);
  });
  it("filters by smsOnly using the texted id set", () => {
    const out = filterRecordsBySlice(recs, { status: "all", outcome: "all", smsOnly: true }, new Set(["b"]));
    expect(out.map((r) => r.campaignNumberId)).toEqual(["b"]);
  });
  it("filters by contact status", () => {
    const out = filterRecordsBySlice(recs, { status: "voicemail", outcome: "all", smsOnly: false }, new Set());
    // neither has status 'voicemail' (both default 'unreached' / set above) → none
    expect(out.length).toBe(0);
  });
});

describe("paginate", () => {
  it("returns the page window + true total", () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    expect(paginate(rows, 10, 5)).toEqual({ page: [10, 11, 12, 13, 14], total: 25 });
  });
  it("clamps an over-range offset to an empty page but keeps the total", () => {
    const rows = [1, 2, 3];
    expect(paginate(rows, 50, 10)).toEqual({ page: [], total: 3 });
  });
});
