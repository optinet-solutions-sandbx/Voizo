import { describe, it, expect } from "vitest";
import { parseDeliveryReceipt, normalizeSmsStatus, describeFailure } from "./mobivateDeliveryReceipt";

// Real Mobivate DLR bodies captured from prod Vercel logs (2026-06-18): a form field `xml`
// holding URL-encoded XML <deliveryreceipt>. This is the shape the old handler dropped as
// "unrecognized body format".
const REAL_DELIVERED =
  "xml=%3Cdeliveryreceipt%3E%3Ccreated%3E2026-06-18T11%3A00%3A15.915Z%3C%2Fcreated%3E" +
  "%3CdeliveryMessageId%3E133e4f21-ff94-49d7-9167-77c9bc94cb99%3C%2FdeliveryMessageId%3E" +
  "%3CclientReference%3Ef1c2a2bd-bb90-4776-989e-f653fea1fa3a%3C%2FclientReference%3E" +
  "%3Cstatus%3EDELIVERED%3C%2Fstatus%3E%3CstatusCode%3E1%3C%2FstatusCode%3E" +
  "%3Cpart%3E1%3C%2Fpart%3E%3Cparts%3E1%3C%2Fparts%3E%3C%2Fdeliveryreceipt%3E";

describe("parseDeliveryReceipt", () => {
  it("parses a real Mobivate DELIVERED receipt (xml=-wrapped, URL-encoded XML)", () => {
    const r = parseDeliveryReceipt(REAL_DELIVERED);
    expect(r).not.toBeNull();
    expect(r!.reference).toBe("f1c2a2bd-bb90-4776-989e-f653fea1fa3a"); // our sms_messages_v2.id
    expect(r!.providerMessageId).toBe("133e4f21-ff94-49d7-9167-77c9bc94cb99");
    expect(r!.status).toBe("delivered");
  });

  it("maps UNDELIVERED → undelivered and surfaces a reason when present", () => {
    const body =
      "xml=" +
      encodeURIComponent(
        "<deliveryreceipt><deliveryMessageId>m1</deliveryMessageId>" +
          "<clientReference>ref-1</clientReference><status>UNDELIVERED</status>" +
          "<reason>ABSENT_SUBSCRIBER</reason></deliveryreceipt>",
      );
    const r = parseDeliveryReceipt(body);
    expect(r!.status).toBe("undelivered");
    expect(r!.reference).toBe("ref-1");
    expect(r!.reason).toBe("ABSENT_SUBSCRIBER");
  });

  it("does not confuse <statusCode> with <status>", () => {
    const body = "xml=" + encodeURIComponent("<deliveryreceipt><status>DELIVERED</status><statusCode>1</statusCode></deliveryreceipt>");
    expect(parseDeliveryReceipt(body)!.status).toBe("delivered");
  });

  it("handles a raw XML body (no xml= wrapper)", () => {
    const r = parseDeliveryReceipt("<deliveryreceipt><clientReference>ref-2</clientReference><status>DELIVERED</status></deliveryreceipt>");
    expect(r!.reference).toBe("ref-2");
    expect(r!.status).toBe("delivered");
  });

  it("still supports legacy JSON receipts", () => {
    const r = parseDeliveryReceipt(JSON.stringify({ reference: "ref-3", id: "m3", status: "DELIVERED" }));
    expect(r!.reference).toBe("ref-3");
    expect(r!.providerMessageId).toBe("m3");
    expect(r!.status).toBe("delivered");
  });

  it("still supports legacy form-encoded receipts (id/reference/status)", () => {
    const r = parseDeliveryReceipt("reference=ref-4&id=m4&status=FAILED");
    expect(r!.reference).toBe("ref-4");
    expect(r!.providerMessageId).toBe("m4");
    expect(r!.status).toBe("failed");
  });

  it("returns null for an unrecognized body", () => {
    expect(parseDeliveryReceipt("garbage not xml not json")).toBeNull();
    expect(parseDeliveryReceipt("")).toBeNull();
  });
});

describe("normalizeSmsStatus", () => {
  it("maps known statuses", () => {
    expect(normalizeSmsStatus("DELIVERED")).toBe("delivered");
    expect(normalizeSmsStatus("DELIVRD")).toBe("delivered");
    expect(normalizeSmsStatus("UNDELIVERED")).toBe("undelivered");
    expect(normalizeSmsStatus("ACCEPTED")).toBe("sent");
    expect(normalizeSmsStatus("ENROUTE")).toBe("sent");
  });
  it("treats unknown / non-string as failed (loud, not ambiguous)", () => {
    expect(normalizeSmsStatus("REJECTED")).toBe("failed");
    expect(normalizeSmsStatus("EXPIRED")).toBe("failed");
    expect(normalizeSmsStatus(null)).toBe("failed");
    expect(normalizeSmsStatus(undefined)).toBe("failed");
  });
});

// VOZ-250: every one of the 667 non-delivered rows carried error_message NULL. Two causes, both
// here: the parser dropped the provider's own status WORD (normalizeSmsStatus collapses
// REJECTED / EXPIRED / FAILED_LIMITS_EXCEEDED all into "failed"), and the route never read the
// statusCode it was already parsing. rawStatus + describeFailure are what the route writes.
describe("rawStatus — the provider's own word, kept alongside the normalized status", () => {
  it("keeps <status> verbatim on the real captured DELIVERED receipt", () => {
    const r = parseDeliveryReceipt(REAL_DELIVERED);
    expect(r!.status).toBe("delivered");
    expect(r!.rawStatus).toBe("DELIVERED");
    expect(r!.statusCode).toBe("1");
  });

  it("distinguishes REJECTED from EXPIRED, which both normalize to 'failed'", () => {
    const mk = (s: string) =>
      parseDeliveryReceipt("xml=" + encodeURIComponent(`<deliveryreceipt><clientReference>r</clientReference><status>${s}</status><statusCode>22</statusCode></deliveryreceipt>`));
    const rejected = mk("REJECTED");
    const expired = mk("EXPIRED");
    expect(rejected!.status).toBe("failed");
    expect(expired!.status).toBe("failed");
    // the whole point: identical normalized status, different recorded cause
    expect(rejected!.rawStatus).toBe("REJECTED");
    expect(expired!.rawStatus).toBe("EXPIRED");
    expect(describeFailure(rejected!)).not.toBe(describeFailure(expired!));
  });

  it("carries rawStatus through the JSON and legacy-form branches too", () => {
    expect(parseDeliveryReceipt(JSON.stringify({ reference: "r", id: "m", status: "UNDELIVERED" }))!.rawStatus).toBe("UNDELIVERED");
    expect(parseDeliveryReceipt("reference=r&id=m&status=FAILED")!.rawStatus).toBe("FAILED");
  });

  it("is null when the provider sent no status at all", () => {
    const r = parseDeliveryReceipt("xml=" + encodeURIComponent("<deliveryreceipt><clientReference>r</clientReference></deliveryreceipt>"));
    expect(r!.rawStatus).toBeNull();
    expect(r!.status).toBe("failed"); // unchanged: absent status is still loud
  });
});

describe("describeFailure — what lands in sms_messages_v2.error_message", () => {
  const parsed = (o: Partial<Parameters<typeof describeFailure>[0]>) =>
    describeFailure({ reference: null, providerMessageId: null, status: "failed", statusCode: null, rawStatus: null, reason: null, ...o });

  it("prefers an explicit provider reason, and appends the code", () => {
    expect(parsed({ reason: "ABSENT_SUBSCRIBER", statusCode: "5" })).toBe("ABSENT_SUBSCRIBER (code 5)");
  });

  it("falls back to the provider's status word when there is no reason — the REAL Mobivate shape", () => {
    // Mobivate's XML has <status> + <statusCode> and NO <reason>; this is the case that made
    // all 667 rows NULL, so it is the one that matters most.
    expect(parsed({ rawStatus: "UNDELIVERED", statusCode: "2" })).toBe("UNDELIVERED (code 2)");
  });

  it("records the bare code when that is all the provider gave", () => {
    expect(parsed({ statusCode: "22" })).toBe("code 22");
  });

  it("uses the reason or status alone when no code came through", () => {
    expect(parsed({ reason: "ABSENT_SUBSCRIBER" })).toBe("ABSENT_SUBSCRIBER");
    expect(parsed({ rawStatus: "EXPIRED" })).toBe("EXPIRED");
  });

  it("returns null only when the provider told us nothing — never an empty string", () => {
    // null keeps the column honest: "" would read as "we know the reason and it is blank".
    expect(parsed({})).toBeNull();
  });

  it("does not repeat the status word twice when reason and rawStatus agree", () => {
    expect(parsed({ reason: "EXPIRED", rawStatus: "EXPIRED", statusCode: "3" })).toBe("EXPIRED (code 3)");
  });

  it("reads end to end from a parsed non-delivered receipt", () => {
    const r = parseDeliveryReceipt(
      "xml=" + encodeURIComponent("<deliveryreceipt><deliveryMessageId>m9</deliveryMessageId><clientReference>ref-9</clientReference><status>UNDELIVERED</status><statusCode>2</statusCode></deliveryreceipt>"),
    );
    expect(r!.status).toBe("undelivered");
    expect(describeFailure(r!)).toBe("UNDELIVERED (code 2)");
  });
});
