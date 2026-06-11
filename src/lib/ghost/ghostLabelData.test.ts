import { describe, it, expect } from "vitest";
import { listGhostRunCalls, upsertGhostLabel, callBelongsToCampaign } from "./ghostLabelData";

// Thenable fake supabase (mirrors ghostScrub.test.ts). Routes terminal awaits by
// table; records the upsert payload + .eq() filters. Relative imports only.
function fakeDb(opts: { rows?: unknown[]; single?: unknown; labels?: unknown[] } = {}) {
  const calls = { table: null as string | null, upsert: null as any, eqs: [] as Array<[string, unknown]> };
  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { calls.eqs.push([c, v]); return builder; },
    in: () => builder,
    not: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: () => Promise.resolve({ data: opts.single ?? null, error: null }),
    single: () => Promise.resolve({ data: opts.single ?? null, error: null }),
    upsert: (p: unknown) => { calls.upsert = p; return builder; },
    then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
      resolve({ data: calls.table === "ghost_call_labels" ? (opts.labels ?? []) : (opts.rows ?? []), error: null }),
  };
  return { supabase: { from: (t: string) => { calls.table = t; return builder; } } as any, calls };
}

describe("upsertGhostLabel", () => {
  it("upserts on (call_id, labeled_by) with the verdict + reason", async () => {
    const { supabase, calls } = fakeDb({ single: { call_id: "c1", verdict: "good" } });
    const r = await upsertGhostLabel(supabase, { callId: "c1", labeledBy: "op", verdict: "good", reason: "clean" });
    expect(r).toMatchObject({ call_id: "c1", verdict: "good" });
    expect(calls.upsert).toMatchObject({ call_id: "c1", labeled_by: "op", verdict: "good", reason: "clean" });
  });
});

describe("callBelongsToCampaign", () => {
  it("true when the call's campaign matches", async () => {
    const { supabase, calls } = fakeDb({ single: { id: "c1" } });
    expect(await callBelongsToCampaign(supabase, "c1", "camp1")).toBe(true);
    expect(calls.eqs).toContainEqual(["id", "c1"]);
    expect(calls.eqs).toContainEqual(["campaign_id", "camp1"]);
  });
  it("false when no matching row", async () => {
    const { supabase } = fakeDb({ single: null });
    expect(await callBelongsToCampaign(supabase, "cX", "camp1")).toBe(false);
  });
});

describe("listGhostRunCalls", () => {
  it("returns real-conversation calls joined with this operator's label; drops AI-only", async () => {
    const rows = [
      { id: "c1", created_at: "t1", duration_seconds: 60, status: "completed", goal_reached: true,
        transcript: { text: "AI: Hello, is this Jo?\nUser: Yes, tell me more about the offer." },
        recording_url: "https://storage.vapi.ai/x.mp3", campaign_numbers_v2: { phone_e164: "+15551110000" } },
      { id: "c2", created_at: "t2", duration_seconds: 4, status: "completed", goal_reached: false,
        transcript: { text: "AI: Hello? Anyone there?" }, // AI-only → no real conversation
        recording_url: null, campaign_numbers_v2: { phone_e164: "+15552220000" } },
    ];
    const { supabase } = fakeDb({ rows, labels: [{ call_id: "c1", verdict: "good", reason: null }] });
    const out = await listGhostRunCalls(supabase, "camp1", "op");
    expect(out.map((c) => c.callId)).toEqual(["c1"]); // c2 dropped (no user turn)
    expect(out[0].phoneE164).toBe("+15551110000");
    expect(out[0].audioUrl).toContain("/api/recordings/proxy");
    expect(out[0].yourLabel?.verdict).toBe("good");
  });

  it("returns calls with no label as yourLabel=null", async () => {
    const rows = [
      { id: "c1", created_at: "t1", duration_seconds: 60, status: "completed", goal_reached: false,
        transcript: { text: "AI: Hi.\nUser: Not interested, thanks." }, recording_url: null,
        campaign_numbers_v2: { phone_e164: "+15551110000" } },
    ];
    const { supabase } = fakeDb({ rows, labels: [] });
    const out = await listGhostRunCalls(supabase, "camp1", "op");
    expect(out).toHaveLength(1);
    expect(out[0].yourLabel).toBeNull();
    expect(out[0].audioUrl).toBeNull();
  });
});
