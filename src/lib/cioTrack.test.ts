import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTrackCredential, sendTrackEvent, TRACK_HOST } from "./cioTrack";

/**
 * Email follow-up channel (2026-09-01 plan) — the Track API client.
 *
 * The contract: NEVER throws, and a missing/misconfigured credential fails CLOSED (no send)
 * rather than at import time. The Track credential is "SITEID:APIKEY" per workspace — a shape
 * distinct from every other CIO credential we hold, which is exactly how the App-API keys got
 * mistaken for it in the first place.
 */

const ENV = JSON.stringify({
  lucky7even: "site-l7:key-l7",
  fortuneplay: "site-fp:key-fp",
  roosterbet: "site-rb:key-with:colon", // an API key may itself contain a colon — split on the FIRST
});

describe("resolveTrackCredential — fail closed, always", () => {
  it("resolves a workspace to its siteId + apiKey", () => {
    expect(resolveTrackCredential(ENV, "lucky7even")).toEqual({ siteId: "site-l7", apiKey: "key-l7" });
  });

  it("splits on the FIRST colon only, so a key containing a colon survives intact", () => {
    expect(resolveTrackCredential(ENV, "roosterbet")).toEqual({ siteId: "site-rb", apiKey: "key-with:colon" });
  });

  it.each([
    ["unset env", undefined, "lucky7even"],
    ["empty env", "", "lucky7even"],
    ["invalid JSON", "{oops", "lucky7even"],
    ["a JSON array", "[]", "lucky7even"],
    ["unknown workspace", ENV, "playmojo"],
    ["value without a colon", JSON.stringify({ lucky7even: "no-colon-here" }), "lucky7even"],
    ["empty siteId", JSON.stringify({ lucky7even: ":key" }), "lucky7even"],
    ["empty key", JSON.stringify({ lucky7even: "site:" }), "lucky7even"],
    ["non-string value", JSON.stringify({ lucky7even: 42 }), "lucky7even"],
  ])("returns null for %s — a broken config must mean NO SEND, never a throw", (_l, env, ws) => {
    expect(resolveTrackCredential(env as string | undefined, ws)).toBeNull();
  });
});

describe("sendTrackEvent — never throws, reports honestly", () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const cred = { siteId: "site-l7", apiKey: "key-l7" };

  function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return impl(url, init) as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it("POSTs the event to the cio_-prefixed identifier with basic auth", async () => {
    const calls = mockFetch(async () => ({ ok: true, status: 200, text: async () => "" }));
    const r = await sendTrackEvent({
      credential: cred,
      cioId: "bdba0906bab201dbb00c",
      eventName: "voizo_call_followup",
      data: { brand: "lucky7even", call_outcome: "positive", sms_sent: true },
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://${TRACK_HOST}/api/v1/customers/cio_bdba0906bab201dbb00c/events`);
    expect(calls[0].init?.method).toBe("POST");
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Basic " + Buffer.from("site-l7:key-l7").toString("base64"));
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.name).toBe("voizo_call_followup");
    expect(body.data.call_outcome).toBe("positive");
  });

  it("URL-encodes a hostile cioId so it cannot break out of the path", async () => {
    const calls = mockFetch(async () => ({ ok: true, status: 200, text: async () => "" }));
    await sendTrackEvent({ credential: cred, cioId: "a/b?c#d", eventName: "e", data: {} });
    expect(calls[0].url).toContain("/customers/cio_a%2Fb%3Fc%23d/events");
  });

  it("a non-2xx response is a clean failure carrying the status and body", async () => {
    mockFetch(async () => ({ ok: false, status: 401, text: async () => "Unauthorized request" }));
    const r = await sendTrackEvent({ credential: cred, cioId: "x", eventName: "e", data: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.error).toContain("Unauthorized");
  });

  it("a thrown fetch (network death, abort) is a clean failure — NEVER an exception", async () => {
    global.fetch = vi.fn(async () => { throw new Error("socket hang up"); }) as unknown as typeof fetch;
    const r = await sendTrackEvent({ credential: cred, cioId: "x", eventName: "e", data: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("socket hang up");
  });

  it("passes an abort signal so a hung CIO cannot hold the webhook open (the VOZ-425 class)", async () => {
    const calls = mockFetch(async () => ({ ok: true, status: 200, text: async () => "" }));
    await sendTrackEvent({ credential: cred, cioId: "x", eventName: "e", data: {} });
    expect(calls[0].init?.signal).toBeDefined();
  });

  it("never sends a phone or name even if a caller sneaks one into data", async () => {
    // Defence in depth for the Q1 payload rule: the client strips the fields the plan bans.
    const calls = mockFetch(async () => ({ ok: true, status: 200, text: async () => "" }));
    await sendTrackEvent({
      credential: cred, cioId: "x", eventName: "e",
      data: { brand: "lucky7even", phone: "+61400000000", name: "Liam", phone_e164: "+61400000000" },
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.data.phone).toBeUndefined();
    expect(body.data.phone_e164).toBeUndefined();
    expect(body.data.name).toBeUndefined();
    expect(body.data.brand).toBe("lucky7even");
  });
});
