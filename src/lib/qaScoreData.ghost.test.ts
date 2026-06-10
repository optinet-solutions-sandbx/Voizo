import { describe, it, expect, vi, beforeEach } from "vitest";

// C1 (v1.1 review): the AI QA judge must NEVER score ghost runs. selectUnscoredCalls
// reads calls_v2 directly (its own path, separate from the manual-review
// fetchLabelableCalls), so the source='ghost_portal' exclusion has to live here too.
// Mock the env-throwing service-role singleton; hoisted state lets the mock return
// per-test rows. Routes calls_v2 vs qa_scores by table. Relative imports.
const h = vi.hoisted(() => ({ callsRows: [] as Array<Record<string, unknown>>, scoredRows: [] as Array<{ call_id: string }> }));

vi.mock("./supabaseServer", () => ({
  supabaseAdmin: {
    from(table: string) {
      const result = { data: table === "qa_scores" ? h.scoredRows : h.callsRows, error: null };
      const b: any = {
        select: () => b, not: () => b, eq: () => b, order: () => b,
        range: () => Promise.resolve(result),
        in: () => Promise.resolve(result),
      };
      return b;
    },
  },
}));

import { selectUnscoredCalls } from "./qaScoreData";

const realConvo = (who: string) => ({ text: `AI: Hello.\nUser: ${who}` });

beforeEach(() => {
  h.scoredRows = [];
  h.callsRows = [
    { id: "cGhost", campaign_id: "campG", created_at: "2026-06-09T01:00:00Z", duration_seconds: 60,
      goal_reached: true, transcript: realConvo("Yes, tell me more."), campaigns_v2: { source: "ghost_portal" } },
    { id: "cProd", campaign_id: "campP", created_at: "2026-06-09T02:00:00Z", duration_seconds: 60,
      goal_reached: false, transcript: realConvo("Not interested."), campaigns_v2: { source: "production" } },
  ];
});

describe("selectUnscoredCalls — ghost is never sent to the judge (C1)", () => {
  it("excludes source='ghost_portal' calls from the candidate set", async () => {
    const out = await selectUnscoredCalls("v1", 100);
    expect(out.map((c) => c.id)).toEqual(["cProd"]); // ghost call dropped
  });

  it("excludes ghost even when the embed is array-form", async () => {
    h.callsRows[0].campaigns_v2 = [{ source: "ghost_portal" }];
    const out = await selectUnscoredCalls("v1", 100);
    expect(out.map((c) => c.id)).toEqual(["cProd"]);
  });

  it("keeps production calls (no over-filtering)", async () => {
    h.callsRows = [h.callsRows[1]]; // only the production one
    const out = await selectUnscoredCalls("v1", 100);
    expect(out.map((c) => c.id)).toEqual(["cProd"]);
  });
});
