import { describe, it, expect } from "vitest";
import { dncSuppressedSet } from "./dncScrub";

function fakeSupabase(suppression: string[], dnc: string[]) {
  return {
    from(table: string) {
      const rows =
        table === "suppression_list"
          ? suppression.map((p) => ({ phone_e164: p }))
          : dnc.map((p) => ({ phone_number: p }));
      const b: any = { select: () => b, eq: () => b, in: () => Promise.resolve({ data: rows, error: null }) };
      return b;
    },
  } as any;
}

describe("dncSuppressedSet", () => {
  it("unions suppression_list + do_not_call matches", async () => {
    const set = await dncSuppressedSet(fakeSupabase(["+15551112222"], ["+15553334444"]), [
      "+15551112222", "+15553334444", "+15559998888",
    ]);
    expect(set.has("+15551112222")).toBe(true);
    expect(set.has("+15553334444")).toBe(true);
    expect(set.has("+15559998888")).toBe(false);
  });

  it("returns empty set for empty phone list (no query)", async () => {
    const set = await dncSuppressedSet(fakeSupabase([], []), []);
    expect(set.size).toBe(0);
  });
});
