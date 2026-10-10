// T9: dimValueFromParam / paramValueOfDim now treat "angle" the same as
// "offset" (a typed or parameter value is a magnitude; the constraint keeps
// its own sign). See sketch/angleSign.test.ts for the field report this is
// the foundation of.
import { describe, it, expect } from "vitest";
import { dimValueFromParam, paramValueOfDim } from "./numFields";

describe("dimValueFromParam: angle (like offset) takes a magnitude", () => {
  it("keeps the constraint's negative sign", () => {
    expect(dimValueFromParam({ type: "angle", value: -30 }, 30)).toBe(-30);
    expect(dimValueFromParam({ type: "angle", value: -30 }, -45)).toBe(-45);
  });

  it("keeps the constraint's positive sign", () => {
    expect(dimValueFromParam({ type: "angle", value: 30 }, -45)).toBe(45);
  });

  it("leaves every other dimension's value as it is", () => {
    expect(dimValueFromParam({ type: "distance", value: 10 }, -20)).toBe(-20);
  });
});

describe("paramValueOfDim: angle (like offset) names a magnitude", () => {
  it("drops the sign", () => {
    expect(paramValueOfDim({ type: "angle", value: -30 })).toBe(30);
    expect(paramValueOfDim({ type: "angle", value: 30 })).toBe(30);
  });

  it("leaves every other dimension's value as it is", () => {
    expect(paramValueOfDim({ type: "distance", value: -20 })).toBe(-20);
  });
});

describe("round-trip: naming then re-applying a parameter moves nothing", () => {
  it.each([-179, -30, 30, 180])("holds for stored value %d", (stored) => {
    const c = { type: "angle", value: stored };
    expect(dimValueFromParam(c, paramValueOfDim(c))).toBe(stored);
  });
});
