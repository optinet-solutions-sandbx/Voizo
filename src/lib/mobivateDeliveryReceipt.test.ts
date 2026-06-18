import { describe, it, expect } from "vitest";
import { parseDeliveryReceipt, normalizeSmsStatus } from "./mobivateDeliveryReceipt";

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
