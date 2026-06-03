import { describe, it, expect } from "vitest";
import { audienceTzGuard } from "./audienceCountry";

const au = ["+61400000001", "+61400000002", "+61400000003", "+61400000004", "+61400000005"];
const na = ["+14165550001", "+14165550002", "+14165550003", "+14165550004", "+14165550005"];

describe("audienceTzGuard", () => {
  it("blocks AU numbers on a non-AU tz (no ack)", () =>
    expect(audienceTzGuard(au, "Europe/Paris", null)).toMatch(/Australia\/Sydney/));
  it("allows AU on Australia/Sydney", () => expect(audienceTzGuard(au, "Australia/Sydney", null)).toBeNull());
  it("allows +1/NA on a US/CA tz", () => expect(audienceTzGuard(na, "America/Toronto", null)).toBeNull());
  it("allows when country undetectable (<5)", () =>
    expect(audienceTzGuard(au.slice(0, 3), "Europe/Paris", null)).toBeNull());
  it("allows when ack matches THIS mismatch", () =>
    expect(audienceTzGuard(au, "Europe/Paris", "AU:Europe/Paris")).toBeNull());
  it("re-blocks when ack key is for a different tz", () =>
    expect(audienceTzGuard(au, "Europe/Paris", "AU:Europe/Berlin")).toMatch(/Australia\/Sydney/));
});
