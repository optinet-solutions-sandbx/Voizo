import { describe, it, expect } from "vitest";
import { parseGhostUpload } from "./ghostUpload";

describe("parseGhostUpload", () => {
  it("paste: newline/comma list → normalized E.164, deduped", () => {
    // "+15551112222" and "+1 (555) 111-2222" both normalize to the same E.164 → deduped.
    const r = parseGhostUpload("paste", "+15551112222\n+1 (555) 111-2222, +447700900000");
    expect(r.targets.map((t) => t.phone)).toEqual(["+15551112222", "+447700900000"]);
    expect(r.rejected).toHaveLength(0);
  });

  it("json: array of objects, phone + meta retained", () => {
    const r = parseGhostUpload("json", JSON.stringify([{ phone: "+15551112222", name: "Al" }]));
    expect(r.targets[0].phone).toBe("+15551112222");
    expect(r.targets[0].meta).toEqual({ name: "Al" });
  });

  it("json: non-array → reported as rejected, no throw", () => {
    const r = parseGhostUpload("json", JSON.stringify({ phone: "+15551112222" }));
    expect(r.targets).toHaveLength(0);
    expect(r.rejected).toEqual(["(not a JSON array)"]);
  });

  it("csv: phone column + extra cols → meta; bad rows reported not dropped", () => {
    const r = parseGhostUpload("csv", "phone,name\n+15551112222,Al\nnotaphone,Bo");
    expect(r.targets).toHaveLength(1);
    expect(r.targets[0].meta).toEqual({ name: "Al" });
    expect(r.rejected).toEqual(["notaphone,Bo"]);
  });

  it("csv: missing phone header → rejected, no throw", () => {
    const r = parseGhostUpload("csv", "name,email\nAl,a@x.com");
    expect(r.targets).toHaveLength(0);
    expect(r.rejected).toEqual(["(no 'phone' column in header)"]);
  });
});
