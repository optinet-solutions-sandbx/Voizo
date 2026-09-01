import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * VOZ-250 — the WIRING test.
 *
 * The parser had been extracting <statusCode> correctly for months; the route simply never read
 * it, and Mobivate's XML carries no <reason>, so `error_message` was written NULL on all 667
 * non-delivered rows. Every unit test on describeFailure passes whether or not the route calls
 * it — so the formatter's coverage does NOT cover the defect. This file asserts what actually
 * reaches the UPDATE payload.
 */

// vi.mock factories are hoisted — shared mutable state must come from vi.hoisted.
const state = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  row: null as { id: string } | null,
  selects: [] as Array<{ column: string; value: unknown }>,
}));

vi.mock("../../../../../lib/supabaseServer", () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: (column: string, value: unknown) => ({
          maybeSingle: async () => {
            state.selects.push({ column, value });
            return { data: state.row };
          },
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        state.updates.push(payload);
        return { eq: async () => ({ error: null }) };
      },
    }),
  },
}));

import { POST } from "./route";

const xmlBody = (inner: string) => "xml=" + encodeURIComponent(`<deliveryreceipt>${inner}</deliveryreceipt>`);
const post = (body: string) => POST({ text: async () => body } as unknown as NextRequest);

beforeEach(() => {
  state.updates = [];
  state.selects = [];
  state.row = { id: "sms-1" };
});

describe("POST /api/webhooks/mobivate/delivery-status — what lands in error_message", () => {
  it("writes the provider's cause on an UNDELIVERED receipt (the 667-NULL-rows bug)", async () => {
    const res = await post(
      xmlBody("<deliveryMessageId>m1</deliveryMessageId><clientReference>sms-1</clientReference><status>UNDELIVERED</status><statusCode>2</statusCode>"),
    );
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].status).toBe("undelivered");
    // The regression guard: this was NULL before the fix.
    expect(state.updates[0].error_message).toBe("UNDELIVERED (code 2)");
  });

  it("distinguishes two receipts that both normalize to 'failed'", async () => {
    await post(xmlBody("<clientReference>sms-1</clientReference><status>REJECTED</status><statusCode>22</statusCode>"));
    await post(xmlBody("<clientReference>sms-1</clientReference><status>EXPIRED</status><statusCode>3</statusCode>"));
    expect(state.updates.map((u) => u.status)).toEqual(["failed", "failed"]);
    expect(state.updates.map((u) => u.error_message)).toEqual(["REJECTED (code 22)", "EXPIRED (code 3)"]);
  });

  it("still writes NULL on delivered — a success must never carry an error string", async () => {
    await post(xmlBody("<clientReference>sms-1</clientReference><status>DELIVERED</status><statusCode>1</statusCode>"));
    expect(state.updates[0].status).toBe("delivered");
    expect(state.updates[0].error_message).toBeNull();
  });

  it("prefers an explicit <reason> over the status word when the provider sends one", async () => {
    await post(xmlBody("<clientReference>sms-1</clientReference><status>UNDELIVERED</status><statusCode>5</statusCode><reason>ABSENT_SUBSCRIBER</reason>"));
    expect(state.updates[0].error_message).toBe("ABSENT_SUBSCRIBER (code 5)");
  });

  it("records the status word alone when no code came through — still better than NULL", async () => {
    await post(xmlBody("<clientReference>sms-1</clientReference><status>UNDELIVERED</status>"));
    expect(state.updates[0].error_message).toBe("UNDELIVERED");
  });

  it("writes NULL, not an empty string, when the receipt carries no cause at all", async () => {
    // No <status>, no <statusCode>, no <reason>: normalizeSmsStatus makes this 'failed' (loud),
    // and there is genuinely nothing to record. NULL means "unknown"; "" would read as
    // "we know the reason and it is blank".
    await post(xmlBody("<clientReference>sms-1</clientReference>"));
    expect(state.updates[0].status).toBe("failed");
    expect(state.updates[0].error_message).toBeNull();
  });

  it("matches the row on our clientReference and carries provider_message_id through", async () => {
    await post(xmlBody("<deliveryMessageId>prov-9</deliveryMessageId><clientReference>sms-1</clientReference><status>UNDELIVERED</status><statusCode>2</statusCode>"));
    expect(state.selects[0]).toEqual({ column: "id", value: "sms-1" });
    expect(state.updates[0].provider_message_id).toBe("prov-9");
  });

  // An interim receipt is not a failure. normalizeSmsStatus folds ACCEPTED / SENT / ENROUTE into
  // 'sent', so gating on "!== delivered" would stamp an error string onto a message still in
  // flight — and the dashboard + CSV exports print error_message verbatim.
  it.each(["ACCEPTED", "ENROUTE", "SENT"])("leaves error_message NULL on an interim %s receipt", async (word) => {
    await post(xmlBody(`<clientReference>sms-1</clientReference><status>${word}</status><statusCode>1</statusCode>`));
    expect(state.updates[0].status).toBe("sent");
    expect(state.updates[0].error_message).toBeNull();
  });

  it("200s an unrecognized body without touching the database (no Mobivate retry storm)", async () => {
    const res = await post("garbage not xml not json");
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(0);
  });

  it("200s an unmatched reference without writing", async () => {
    state.row = null;
    const res = await post(xmlBody("<clientReference>nope</clientReference><status>UNDELIVERED</status><statusCode>2</statusCode>"));
    expect(res.status).toBe(200);
    expect(state.updates).toHaveLength(0);
  });
});
