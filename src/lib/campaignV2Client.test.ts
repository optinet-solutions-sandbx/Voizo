import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchCampaignsV2,
  fetchCampaignV2,
  createCampaignV2,
  updateCampaignV2Status,
  fetchCampaignAnalytics,
  loadCampaignsPageCache,
  saveCampaignsPageCache,
} from "./campaignV2Client";

// campaignV2Client is the BROWSER half of RLS Phase A: every function fetches an
// auth-gated /api/campaigns-v2 route (service role) instead of touching the anon
// Supabase client. These tests pin the URL, method, body, return shape, and the
// throw-on-non-2xx contract that the calling components' try/catch relies on.

type FetchCall = { url: string; init?: RequestInit };

function stubFetch(response: {
  ok: boolean;
  status: number;
  json?: unknown;
}): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  global.fetch = vi.fn(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchCampaignsV2", () => {
  it("GETs /api/campaigns-v2 and returns the campaigns array", async () => {
    const { calls } = stubFetch({ ok: true, status: 200, json: { campaigns: [{ id: "a" }, { id: "b" }] } });
    const rows = await fetchCampaignsV2();
    expect(calls[0].url).toBe("/api/campaigns-v2");
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("returns [] when the route omits campaigns", async () => {
    stubFetch({ ok: true, status: 200, json: {} });
    expect(await fetchCampaignsV2()).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(fetchCampaignsV2()).rejects.toThrow(/500/);
  });
});

describe("fetchCampaignV2", () => {
  it("GETs /api/campaigns-v2/:id and returns the campaign row", async () => {
    const { calls } = stubFetch({ ok: true, status: 200, json: { id: "c1", name: "X" } });
    const row = await fetchCampaignV2("c1");
    expect(calls[0].url).toBe("/api/campaigns-v2/c1");
    expect(row).toEqual({ id: "c1", name: "X" });
  });

  it("throws on 404 (not found), matching the old .single() behaviour", async () => {
    stubFetch({ ok: false, status: 404 });
    await expect(fetchCampaignV2("missing")).rejects.toThrow(/404/);
  });
});

describe("createCampaignV2", () => {
  it("POSTs the input as JSON and returns { campaign, numberCount }", async () => {
    const { calls } = stubFetch({
      ok: true,
      status: 200,
      json: { campaign: { id: "new1" }, numberCount: 3 },
    });
    const input = { name: "C", numbers: ["+1234567890"] } as never;
    const result = await createCampaignV2(input);

    expect(calls[0].url).toBe("/api/campaigns-v2");
    expect(calls[0].init?.method).toBe("POST");
    expect((calls[0].init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ name: "C", numbers: ["+1234567890"] });
    expect(result).toEqual({ campaign: { id: "new1" }, numberCount: 3 });
  });

  it("throws with the server error message on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 400, json: { error: "Audience required" } });
    await expect(createCampaignV2({} as never)).rejects.toThrow(/Audience required/);
  });
});

describe("updateCampaignV2Status", () => {
  it("POSTs { status } to /api/campaigns-v2/:id/status and returns the row", async () => {
    const { calls } = stubFetch({ ok: true, status: 200, json: { id: "c1", status: "paused" } });
    const row = await updateCampaignV2Status("c1", "paused");

    expect(calls[0].url).toBe("/api/campaigns-v2/c1/status");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ status: "paused" });
    expect(row).toEqual({ id: "c1", status: "paused" });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 400, json: { error: "Invalid status" } });
    await expect(updateCampaignV2Status("c1", "bogus")).rejects.toThrow(/Invalid status/);
  });
});

// ── campaigns page cache (stale-while-revalidate) ────────────────────────────
// Node test env has no sessionStorage — a Map-backed fake is installed per test
// and removed after. The helpers' contract: NEVER throw (corrupt JSON, missing
// key, quota, or absent storage all degrade to null / a warning).

function stubSessionStorage(opts: { throwOnSet?: boolean } = {}) {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).sessionStorage;
});

describe("campaigns page cache", () => {
  it("round-trips campaigns + analytics through sessionStorage", () => {
    stubSessionStorage();
    saveCampaignsPageCache([{ id: "c1" }], { c1: { targeted: 5 } } as never);
    const cached = loadCampaignsPageCache();
    expect(cached?.campaigns).toEqual([{ id: "c1" }]);
    expect(cached?.analytics).toEqual({ c1: { targeted: 5 } });
    expect(typeof cached?.savedAt).toBe("number");
  });

  it("returns null when the snapshot is absent, corrupt, or mis-shaped", () => {
    const store = stubSessionStorage();
    expect(loadCampaignsPageCache()).toBeNull(); // absent
    store.set("voizo.campaignsPage.v1", "{not json");
    expect(loadCampaignsPageCache()).toBeNull(); // corrupt
    store.set("voizo.campaignsPage.v1", JSON.stringify({ campaigns: "nope", analytics: {} }));
    expect(loadCampaignsPageCache()).toBeNull(); // mis-shaped
  });

  it("returns null when sessionStorage itself is unavailable (SSR/disabled)", () => {
    // No stub installed — accessing sessionStorage throws ReferenceError.
    expect(loadCampaignsPageCache()).toBeNull();
  });

  it("save never throws — a quota error degrades to a warning", () => {
    stubSessionStorage({ throwOnSet: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => saveCampaignsPageCache([], {})).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("fetchCampaignAnalytics", () => {
  it("GETs /api/campaigns-v2/analytics and returns the computed per-campaign map", async () => {
    // 2026-08-05: the route computes server-side — the response is
    // { analytics: Record<campaignId, CampaignAnalytics> }, never raw rows.
    const { calls } = stubFetch({
      ok: true,
      status: 200,
      json: { analytics: { c1: { targeted: 10, reach: 3 } } },
    });
    const analytics = await fetchCampaignAnalytics();
    expect(calls[0].url).toBe("/api/campaigns-v2/analytics");
    expect(analytics).toEqual({ c1: { targeted: 10, reach: 3 } });
  });

  it("defaults a missing analytics key to {} and throws on non-2xx", async () => {
    stubFetch({ ok: true, status: 200, json: {} });
    expect(await fetchCampaignAnalytics()).toEqual({});
    stubFetch({ ok: false, status: 500 });
    await expect(fetchCampaignAnalytics()).rejects.toThrow(/500/);
  });
});
