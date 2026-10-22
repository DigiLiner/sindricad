// The search that turns "which depth steps still resolve" into a bit count.
// The GL half (two quads a 2^-k step apart in one pixel) needs a real context;
// it is exercised through the app in the depth e2e and the GPU rig.
import { describe, it, expect } from "vitest";
import { highestResolved } from "./depthProbe";

describe("highestResolved", () => {
  it("is the last step that resolves", () => {
    expect(highestResolved(8, 24, (k) => k <= 24)).toBe(24);
    expect(highestResolved(8, 24, (k) => k <= 16)).toBe(16);
  });

  it("stops at the first failure, so a fluke at a finer step does not count", () => {
    expect(highestResolved(8, 24, (k) => k <= 12 || k === 20)).toBe(12);
  });

  it("is lo - 1 when nothing resolves", () => {
    expect(highestResolved(8, 24, () => false)).toBe(7);
  });
});
