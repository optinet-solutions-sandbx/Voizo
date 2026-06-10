import { describe, it, expect, vi } from "vitest";

// labelData imports the env-throwing service-role singleton at module load; mock
// it so we can unit-test the pure ghost-exclusion predicate. Relative imports.
vi.mock("./supabaseServer", () => ({ supabaseAdmin: {} }));

import { isGhostCallRow } from "./labelData";

const brief = (source: string | null) => ({ name: "L7_AU_x", is_test: false, created_at: null, source });

describe("isGhostCallRow (main /reviews ghost exclusion)", () => {
  it("true when the embedded campaign source is ghost_portal (object embed)", () => {
    expect(isGhostCallRow({ campaigns_v2: brief("ghost_portal") } as never)).toBe(true);
  });

  it("true when the embed is an array whose element is ghost", () => {
    expect(isGhostCallRow({ campaigns_v2: [brief("ghost_portal")] } as never)).toBe(true);
  });

  it("false for production / null source / null embed", () => {
    expect(isGhostCallRow({ campaigns_v2: brief("production") } as never)).toBe(false);
    expect(isGhostCallRow({ campaigns_v2: brief(null) } as never)).toBe(false);
    expect(isGhostCallRow({ campaigns_v2: null } as never)).toBe(false);
  });
});
