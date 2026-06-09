import { describe, it, expect } from "vitest";
import { orderDraftsProdFirst } from "./draftPriority";

describe("orderDraftsProdFirst", () => {
  it("starts production drafts before ghost_portal drafts even when ghost is earlier", () => {
    const out = orderDraftsProdFirst([
      { id: "g", source: "ghost_portal", start_at: "2026-06-01T08:00:00Z" },
      { id: "p", source: "production", start_at: "2026-06-01T09:00:00Z" },
    ]);
    expect(out.map((d) => d.id)).toEqual(["p", "g"]);
  });

  it("keeps FIFO (earliest start_at) among same-source drafts", () => {
    const out = orderDraftsProdFirst([
      { id: "late", source: "production", start_at: "2026-06-01T10:00:00Z" },
      { id: "early", source: "production", start_at: "2026-06-01T08:00:00Z" },
    ]);
    expect(out.map((d) => d.id)).toEqual(["early", "late"]);
  });

  it("treats missing/undefined source as production (legacy rows pre-source column)", () => {
    const out = orderDraftsProdFirst([
      { id: "ghost", source: "ghost_portal", start_at: "2026-06-01T08:00:00Z" },
      { id: "legacy", start_at: "2026-06-01T09:00:00Z" },
    ]);
    expect(out[0].id).toBe("legacy");
  });

  it("does not mutate the input array", () => {
    const input = [
      { id: "g", source: "ghost_portal", start_at: "2026-06-01T08:00:00Z" },
      { id: "p", source: "production", start_at: "2026-06-01T09:00:00Z" },
    ];
    const copy = input.map((d) => ({ ...d }));
    orderDraftsProdFirst(input);
    expect(input).toEqual(copy);
  });
});
