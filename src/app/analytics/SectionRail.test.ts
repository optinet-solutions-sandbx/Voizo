import { describe, expect, it } from "vitest";
import { currentSection, SECTIONS } from "./SectionRail";

describe("currentSection", () => {
  it("is the first section until any top has passed the line", () => {
    expect(currentSection([100, 900, 1800], 60)).toBe(0);
  });
  it("is the last section whose top passed the line", () => {
    expect(currentSection([-400, 20, 900], 60)).toBe(1);
    expect(currentSection([-900, -400, -10, 500, 1200], 60)).toBe(2);
  });
  it("skips a section that is not on the page", () => {
    expect(currentSection([-400, null, -10], 60)).toBe(2);
    expect(currentSection([-400, null, 900], 60)).toBe(0);
  });
  it("names five anchors with unique ids", () => {
    expect(SECTIONS.length).toBe(5);
    expect(new Set(SECTIONS.map(([id]) => id)).size).toBe(5);
  });
});
