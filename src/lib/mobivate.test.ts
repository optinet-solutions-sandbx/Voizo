import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSmsSenderId } from "./mobivate";
import { CIO_DEFAULT_WORKSPACE } from "./customerio";

// Per-brand SMS originator. Mirrors resolveAppApiKey (VOZ-198): the brand is the
// campaigns_v2.cio_workspace label; a null/blank workspace is the default brand;
// a non-default brand NEVER borrows the default sender (wrong-brand guard). Reads
// env at call time so these tests can steer it.
describe("resolveSmsSenderId (per-brand SMS originator)", () => {
  const savedSingle = process.env.MOBIVATE_SENDER_ID;
  const savedMap = process.env.MOBIVATE_SENDER_IDS;

  beforeEach(() => {
    delete process.env.MOBIVATE_SENDER_ID;
    delete process.env.MOBIVATE_SENDER_IDS;
  });
  afterEach(() => {
    if (savedSingle === undefined) delete process.env.MOBIVATE_SENDER_ID;
    else process.env.MOBIVATE_SENDER_ID = savedSingle;
    if (savedMap === undefined) delete process.env.MOBIVATE_SENDER_IDS;
    else process.env.MOBIVATE_SENDER_IDS = savedMap;
  });

  it("default workspace falls back to the legacy single sender when no map exists", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    expect(resolveSmsSenderId()).toEqual({ senderId: "Lucky7even", error: null });
    expect(resolveSmsSenderId(CIO_DEFAULT_WORKSPACE)).toEqual({ senderId: "Lucky7even", error: null });
  });

  it("null / blank workspace mean the default workspace (campaign rows pass cio_workspace straight through)", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    expect(resolveSmsSenderId(null)).toEqual({ senderId: "Lucky7even", error: null });
    expect(resolveSmsSenderId("  ")).toEqual({ senderId: "Lucky7even", error: null });
  });

  it("default workspace prefers its map entry over the legacy sender", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ lucky7even: "L7Map" });
    expect(resolveSmsSenderId()).toEqual({ senderId: "L7Map", error: null });
  });

  it("a second brand resolves from its map entry", () => {
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ lucky7even: "Lucky7even", fortuneplay: "FortunePlay" });
    expect(resolveSmsSenderId("fortuneplay")).toEqual({ senderId: "FortunePlay", error: null });
  });

  it("a second brand NEVER falls back to the legacy sender (fail closed — the wrong-brand guard)", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    const res = resolveSmsSenderId("fortuneplay");
    expect(res.senderId).toBeNull();
    expect(res.error).toContain("fortuneplay");
    expect(res.error).toContain("MOBIVATE_SENDER_IDS");
  });

  it("an empty / non-string map entry counts as missing", () => {
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ fortuneplay: "" });
    expect(resolveSmsSenderId("fortuneplay").senderId).toBeNull();
    process.env.MOBIVATE_SENDER_IDS = JSON.stringify({ fortuneplay: 42 });
    expect(resolveSmsSenderId("fortuneplay").senderId).toBeNull();
  });

  it("malformed map JSON: the default workspace still reaches the legacy sender, others fail closed", () => {
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    process.env.MOBIVATE_SENDER_IDS = "{not json";
    expect(resolveSmsSenderId()).toEqual({ senderId: "Lucky7even", error: null });
    expect(resolveSmsSenderId("fortuneplay").senderId).toBeNull();
  });

  it("no sender anywhere → error naming MOBIVATE_SENDER_ID for the default workspace", () => {
    const res = resolveSmsSenderId();
    expect(res.senderId).toBeNull();
    expect(res.error).toContain("MOBIVATE_SENDER_ID");
  });
});

// ── 2026-08-27: the request body we actually POST ───────────────────────────
// sendSMS reads its env at MODULE LOAD, so each case sets env then imports fresh
// via vi.resetModules() + dynamic import. fetch is stubbed: nothing leaves the
// machine and no message is ever sent.
describe("sendSMS request body", () => {
  const ENV_KEYS = ["MOBIVATE_API_KEY", "MOBIVATE_API_HOST", "MOBIVATE_SENDER_ID"] as const;
  const saved: Record<string, string | undefined> = {};
  let realFetch: typeof globalThis.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.MOBIVATE_API_KEY = "test-key";
    process.env.MOBIVATE_API_HOST = "vortex.example.com";
    process.env.MOBIVATE_SENDER_ID = "Lucky7even";
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    globalThis.fetch = realFetch;
    vi.resetModules();
  });

  // Mobivate's documented /send/batch acceptance: ONE id for the whole batch, no per-message ids.
  const BATCH_ACCEPTED = {
    success: true,
    record: { id: "batch-1", type: "BatchSMS", scheduled: "2026-09-04T09:00:00.000Z", recipientCount: 1 },
  };

  async function captureRequest(
    body: string,
    opts: { campaignName?: string; response?: unknown; ok?: boolean; status?: number } = {},
  ) {
    let captured: Record<string, unknown> | null = null;
    let calledUrl = "";
    globalThis.fetch = (async (url: string, init: { body?: string }) => {
      calledUrl = String(url);
      captured = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        json: async () => opts.response ?? BATCH_ACCEPTED,
      };
    }) as unknown as typeof globalThis.fetch;
    vi.resetModules();
    const { sendSMS } = await import("./mobivate");
    const result = await sendSMS({
      to: "+64211657305",
      body,
      reference: "our-row-id",
      ...(opts.campaignName !== undefined ? { campaignName: opts.campaignName } : {}),
    });
    return { captured: captured as unknown as Record<string, unknown>, calledUrl, result };
  }

  const OFFER =
    "Your 20 totally FREE spins await! Deposit $30 with code LUCKY for 300% bonus up to $500. Ends midnight. https://Lucky-even.win/promotions?fast-deposit=modal&bonus=LUCKY STOP? Qwt5.me";
  const RUN = "Daily Automated Conversion | VOIZO REACTIVATION Campaign - AU (2026-09-04)";

  // 2026-09-04: Mobivate (via Gisela) asked for /send/batch — "send as a campaign" — so their
  // link tracking and per-campaign click report apply. Dispatch stays one text per call end,
  // so every batch carries exactly ONE recipient; nothing upstream of sendSMS changes.
  it("posts to /send/batch with ONE recipient that carries our row id as its reference", () => {
    return captureRequest(OFFER).then(({ captured, calledUrl }) => {
      expect(calledUrl).toBe("https://vortex.example.com/send/batch");
      expect(captured.recipients).toEqual([{ recipient: "64211657305", reference: "our-row-id" }]);
      // the single-send fields must not linger at the top level: a stray top-level `recipient`
      // on the batch path is ignored by Mobivate and the text goes nowhere
      expect(captured.recipient).toBeUndefined();
      expect(captured.reference).toBeUndefined();
    });
  });

  it("the message rides in `text` only — the batch docs name no `body`", () => {
    // The 08-27 both-fields experiment was a single-send shortener probe. Here `text` is the
    // documented field and the only one; a `body` would be dead weight or, worse, the one read.
    return captureRequest(OFFER).then(({ captured }) => {
      expect(captured.text).toBe(OFFER);
      expect(captured.body).toBeUndefined();
    });
  });

  it("keeps URL shortening and opt-out exclusion, in the batch endpoint's own casing", () => {
    return captureRequest(OFFER).then(({ captured }) => {
      expect(captured.shortenUrls).toBe(true);
      // /send/single documents `excludeOptouts`; /send/batch documents `excludeOptOuts`.
      expect(captured.excludeOptOuts).toBe(true);
      expect(captured.excludeOptouts).toBeUndefined();
    });
  });

  it("goes out now: spreadHours is 0 explicitly, never left to a campaign default", () => {
    return captureRequest(OFFER).then(({ captured }) => {
      expect(captured.spreadHours).toBe(0);
      expect(captured.scheduleDateTime).toBeUndefined();
    });
  });

  it("names the Mobivate campaign after OUR run, so their click report lines up with ours", () => {
    return captureRequest(OFFER, { campaignName: RUN }).then(({ captured }) => {
      expect(captured.name).toBe(RUN);
      expect(captured.originator).toBe("Lucky7even");
    });
  });

  it("with no run name the `name` field is omitted, not sent as an empty string", () => {
    return captureRequest(OFFER).then(({ captured }) => {
      expect("name" in captured).toBe(false);
    });
  });

  it("returns the batch id as the provider id — the delivery receipt replaces it with the message id", () => {
    // /send/batch answers with the BATCH's id (type BatchSMS), not a message id. The receipt
    // route matches our `reference` first and overwrites provider_message_id with Mobivate's
    // real <deliveryMessageId>, so this value is a placeholder for the ~6s until the receipt lands.
    return captureRequest(OFFER).then(({ result }) => {
      expect(result).toEqual({ success: true, providerMessageId: "batch-1", error: null });
    });
  });

  it("a 200 with no record id is a failure, never a silent success", () => {
    return captureRequest(OFFER, { response: { success: true } }).then(({ result }) => {
      expect(result.success).toBe(false);
      expect(result.providerMessageId).toBeNull();
    });
  });

  it("a non-2xx surfaces Mobivate's message so the sms row records why", () => {
    return captureRequest(OFFER, { ok: false, status: 400, response: { success: false, message: "originator not allowed" } })
      .then(({ result }) => {
        expect(result).toEqual({ success: false, providerMessageId: null, error: "originator not allowed" });
      });
  });
});
