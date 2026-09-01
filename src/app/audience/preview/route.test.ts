import { describe, expect, it } from "vitest";
import { GET } from "./route";
import { PREVIEW_HTML } from "./previewHtml";

/**
 * /audience/preview — the frozen design preview of the proposed Audience tab.
 * The contract: it serves the generated mockup, clearly ribboned as a preview, uncached,
 * and carrying the load-bearing honesty rules the mockup's own 124-check gate enforces.
 * (Those rules are re-asserted here in miniature so a bad REGENERATION — not just a bad
 * mockup — fails the suite: the generator script is outside the mockup gate's reach.)
 */
describe("GET /audience/preview", () => {
  it("serves HTML, uncached", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(PREVIEW_HTML);
  });

  it("the PREVIEW ribbon is present and says the numbers are fixtures, not live", () => {
    expect(PREVIEW_HTML).toContain(">PREVIEW</span>");
    expect(PREVIEW_HTML).toContain("not live");
    expect(PREVIEW_HTML).toContain("measured 26 Aug");
  });

  it("carries the ported reporting surfaces", () => {
    for (const s of ["Channel reach", "SMS delivery", "Depositors only", "When the money came"]) {
      expect(PREVIEW_HTML).toContain(s);
    }
  });

  it("keeps the honesty rules: not-a-funnel stated, absent feeds are words not numbers", () => {
    expect(PREVIEW_HTML).toContain("not a funnel");
    expect(PREVIEW_HTML).toContain("not tracked");
    expect(PREVIEW_HTML).toContain("none yet");
    expect(PREVIEW_HTML).toContain("not wired");
  });

  it("is a complete document, not a fragment", () => {
    expect(PREVIEW_HTML).toContain("<!doctype html>");
    expect(PREVIEW_HTML).toContain("</html>");
    // the generator's marker discipline: exactly one body open tag, ribbon directly after it
    expect(PREVIEW_HTML.split("<body>").length).toBe(2);
    expect(PREVIEW_HTML.indexOf(">PREVIEW</span>")).toBeGreaterThan(PREVIEW_HTML.indexOf("<body>"));
  });
});
