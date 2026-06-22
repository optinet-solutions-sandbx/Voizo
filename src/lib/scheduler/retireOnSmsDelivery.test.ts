import { describe, it, expect } from "vitest";
import { shouldRetireForSmsDelivery } from "./retireOnSmsDelivery";

describe("shouldRetireForSmsDelivery — stop dialing once the offer SMS is DELIVERED", () => {
  it("retires a pending_retry number whose SMS is delivered", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "pending_retry", smsStatuses: ["delivered"] })).toBe(true);
  });

  it("retires when ANY of the number's SMS rows is delivered", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "pending_retry", smsStatuses: ["failed", "delivered"] })).toBe(true);
  });

  it("does NOT retire on 'sent' only — delivery is unconfirmed (D1: delivered-only)", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "pending_retry", smsStatuses: ["sent"] })).toBe(false);
  });

  it("does NOT retire on 'undelivered' — the offer never landed", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "pending_retry", smsStatuses: ["undelivered"] })).toBe(false);
  });

  it("does NOT retire when the number has no SMS rows", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "pending_retry", smsStatuses: [] })).toBe(false);
  });

  it("does NOT touch an in_progress number even if a prior SMS delivered (a live/just-fired call)", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "in_progress", smsStatuses: ["delivered"] })).toBe(false);
  });

  it("does NOT touch a fresh 'pending' number (not a retry)", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "pending", smsStatuses: ["delivered"] })).toBe(false);
  });

  it("does NOT re-process an already-terminal sent_sms number", () => {
    expect(shouldRetireForSmsDelivery({ outcome: "sent_sms", smsStatuses: ["delivered"] })).toBe(false);
  });

  it("does NOT retire on a null/unknown outcome", () => {
    expect(shouldRetireForSmsDelivery({ outcome: null, smsStatuses: ["delivered"] })).toBe(false);
  });
});
