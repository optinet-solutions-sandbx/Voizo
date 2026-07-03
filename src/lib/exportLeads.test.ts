import { describe, it, expect } from "vitest";
import { buildExportLeads, type ExportCallRow, type ExportNumberRow, type ExportSmsRow } from "./exportLeads";

const num = (id: string, over: Partial<ExportNumberRow> = {}): ExportNumberRow => ({
  id,
  phone_e164: `+44${id}`,
  outcome: "sent_sms",
  ...over,
});

describe("buildExportLeads — per-contact export detail", () => {
  const numbers: ExportNumberRow[] = [num("n1"), num("n2", { outcome: "unreached" })];
  const calls: ExportCallRow[] = [
    // n1, attempt 2 (later) — goal reached, plain-string transcript, no recording
    { campaign_number_id: "n1", status: "completed", goal_reached: true, duration_seconds: 45, transcript: "yes please", recording_url: null, created_at: "2026-06-20T10:05:00Z" },
    // n1, attempt 1 (earlier) — jsonb {text} transcript + a recording url
    { campaign_number_id: "n1", status: "completed", goal_reached: false, duration_seconds: 30, transcript: { text: "hi" }, recording_url: "https://rec/1.wav", created_at: "2026-06-20T10:00:00Z" },
  ];
  const sms: ExportSmsRow[] = [
    { campaign_number_id: "n1", body: "Your 300% offer…", status: "delivered", provider_message_id: "pm1", error_message: null, created_at: "2026-06-20T10:06:00Z", updated_at: "2026-06-20T10:06:30Z" },
  ];

  it("groups calls per contact, sorts attempts asc, unwraps jsonb transcript, maps sms + outcome", () => {
    const byId = buildExportLeads(numbers, calls, sms);
    const l1 = byId.get("n1");
    expect(l1).toBeTruthy();
    expect(l1!.phone).toBe("+44n1");
    expect(l1!.outcome).toBe("sent_sms");
    expect(l1!.attemptCount).toBe(2);
    expect(l1!.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    expect(l1!.attempts[0].transcript).toBe("hi"); // earlier call first, jsonb {text} unwrapped
    expect(l1!.attempts[0].recordingUrl).toBe("https://rec/1.wav");
    expect(l1!.attempts[1].transcript).toBe("yes please");
    expect(l1!.attempts[1].goalReached).toBe(true);
    expect(l1!.lastAttemptedAt).toBe("2026-06-20T10:05:00Z");
    expect(l1!.smsMessages).toEqual([
      { body: "Your 300% offer…", status: "delivered", providerMessageId: "pm1", errorMessage: null, createdAt: "2026-06-20T10:06:00Z", updatedAt: "2026-06-20T10:06:30Z" },
    ]);
  });

  it("emits a lead with empty attempts/sms for a contact that was never dialed", () => {
    const byId = buildExportLeads(numbers, calls, sms);
    const l2 = byId.get("n2");
    expect(l2).toBeTruthy();
    expect(l2!.attempts).toEqual([]);
    expect(l2!.smsMessages).toEqual([]);
    expect(l2!.attemptCount).toBe(0);
    expect(l2!.lastAttemptedAt).toBeNull();
  });
});
