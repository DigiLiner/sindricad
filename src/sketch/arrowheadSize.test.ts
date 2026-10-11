// b27735e2 (field report, beta 0.1.244): "can the dimension arrowheads be a
// consistent size... and small please". A linear dimension's and a circle's
// diameter badge's arrowhead size were both derived from the MEASURED VALUE
// (`clamp(value * 0.08, 1.4, 4)` / `clamp(r * 0.16, 1.4, 4)`), so a short
// dimension's arrow was up to ~3x smaller than a long one's, and — unlike
// `dimOffset` in the same file, which multiplies by the live `mmPerPx` so a
// label keeps its on-screen clearance across zoom — neither read `mmPerPx` at
// all, so the same dimension's arrow grew or shrank with zoom instead of
// holding one constant screen size.
//
// The fix (entityDims.arrowSize): a constant PIXEL size times the live
// mm-per-pixel, the same pattern `dimOffset` already used.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { linearDim, diameterDim, setDimPixelScale } from "./entityDims";

function arrowheadSize(lines: [THREE.Vector2, THREE.Vector2][]): number {
  const left = lines[3]!, right = lines[4]!;
  const tip = left[0];
  const back = left[1].clone().add(right[1]).multiplyScalar(0.5);
  return tip.distanceTo(back);
}

describe("b27735e2: dimension arrowheads are one small constant screen size", () => {
  it("a short and a long linear dimension get the same arrowhead size", () => {
    const a = new THREE.Vector2(0, 0);
    const offDir = new THREE.Vector2(0, 1);
    const short = linearDim(a, new THREE.Vector2(5, 0), offDir, 5);
    const long = linearDim(a, new THREE.Vector2(600, 0), offDir, 600);
    expect(arrowheadSize(short.lines)).toBeCloseTo(arrowheadSize(long.lines), 5);
  });

  it("a small and a large circle's diameter badge get the same arrowhead size", () => {
    const small = diameterDim(0, 0, 3, null);
    const big = diameterDim(0, 0, 100, null);
    expect(arrowheadSize(small.lines)).toBeCloseTo(arrowheadSize(big.lines), 5);
  });

  it("the same dimension's arrowhead holds a constant SCREEN size across zoom", () => {
    const a = new THREE.Vector2(0, 0);
    const offDir = new THREE.Vector2(0, 1);
    try {
      setDimPixelScale(1); // zoomed in: 1 mm/px
      const zoomedIn = arrowheadSize(linearDim(a, new THREE.Vector2(50, 0), offDir, 50).lines);
      setDimPixelScale(10); // zoomed out 10x: 10 mm/px
      const zoomedOut = arrowheadSize(linearDim(a, new THREE.Vector2(50, 0), offDir, 50).lines);
      // its WORLD size scales with mmPerPx, so its SCREEN size (world / mmPerPx)
      // stays constant.
      expect(zoomedOut).toBeCloseTo(zoomedIn * 10, 0);
    } finally {
      setDimPixelScale(0); // restore the module's default (no other test relies on a scale)
    }
  });
});
