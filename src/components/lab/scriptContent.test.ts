import { describe, expect, it } from "vitest";
import { CONTENT_META, metaOf, type Content } from "./scriptContent";

describe("metaOf", () => {
  it("known content type resolves to its own meta", () => {
    expect(metaOf("collection")).toBe(CONTENT_META.collection);
    expect(metaOf("end")).toBe(CONTENT_META.end);
  });

  it("terminal flag survives the lookup (regression: end/transfer/return stay terminal)", () => {
    expect(metaOf("end").terminal).toBe(true);
    expect(metaOf("transfer").terminal).toBe(true);
    expect(metaOf("scenario").terminal).toBeFalsy();
  });

  // The canvas crash: a legacy node carries config.contentType outside the 9
  // keys (e.g. "ifelse"/"loop", dropped from the union). Raw CONTENT_META[x]
  // was undefined → .terminal/.color threw. metaOf must fall back, never undefined.
  it("out-of-set content type falls back to scenario instead of undefined", () => {
    expect(metaOf("ifelse" as Content)).toBe(CONTENT_META.scenario);
    expect(metaOf("loop" as Content)).toBe(CONTENT_META.scenario);
    // the exact access that used to throw:
    expect(() => metaOf("ifelse" as Content).terminal).not.toThrow();
    expect(metaOf("ifelse" as Content).color).toBeTruthy();
  });
});
