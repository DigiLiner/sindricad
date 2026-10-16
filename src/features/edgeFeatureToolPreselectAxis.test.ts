// Review finding (194fcda1 follow-up, major x2): the fix that recomputes the
// drag axis from the real member edges only covers enterEditUI() (re-opening
// a saved fillet/chamfer) and afterMembershipChange() (after adding/removing
// a member mid-drag). It left the pre-selection CREATE entry — Ctrl-click one
// or more edges in the viewport, then click Fillet/Chamfer, with no further
// add/remove — passing an explicit `null` tangent into beginDrag(), which
// beginDrag assigned straight to this.tangent with nothing recomputing it.
// That reproduces the original "stuck axis" bug (194fcda1) through a
// different, equally standard entry gesture: computeAxis() falls back to the
// camera's fixed right vector instead of an axis derived from the actual
// picked edge, so at camera angles where that fixed axis isn't aligned with
// "more material" the drag barely moves the value.
//
// This test drives the real, public start("fillet", ...) with a single
// pre-selected edge running diagonally (NOT aligned with the camera-right
// vector), the same way Ctrl-click pre-selection reaches EdgeFeatureTool.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FakeEl } from "../ui/fakeDom.testkit";
import type { DocumentStore } from "../document/store";
import type { Viewport } from "../viewport/viewport";
import type { Selector } from "../types";

const promptEl = new FakeEl("div");
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new FakeEl(tag),
  body: new FakeEl("body"),
  getElementById: (id: string) => (id === "prompt" ? promptEl : null),
};
(globalThis as unknown as { window: unknown }).window = {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = () => 1;
(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = () => {};

const { EdgeFeatureTool } = await import("./../features/edgeFeatureTool");

// A diagonal edge from (0,0,0) to (10,10,0) — 45° off world X, so its
// cross-with-forward axis differs from the camera-right fallback (1,0,0).
const DIAGONAL: Selector = { kind: "edge", point: [5, 5, 0] } as unknown as Selector;
const DIAGONAL_LINE = { id: "e0", points: [[0, 0, 0], [10, 10, 0]], body: undefined };

function harness() {
  const el = { style: { cursor: "" }, addEventListener() {}, removeEventListener() {} };
  const store = {
    document: { features: [], parameters: [] },
    buildState: { result: null },
    nextId: () => "prev1",
    setPreview: () => {},
    setEditPreview: () => {},
    onBuild: () => () => {},
  } as unknown as DocumentStore;

  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const viewport = {
    camera,
    domElement: el,
    suspendPicking: false,
    clearHover() {},
    requestRender() {},
    addToScene() {},
    addEdgeOverlay() {},
    removeFromScene() {},
    // pre-selection: a single diagonal edge, the Ctrl-click entry point
    selectedEdgeSelectors: () => [DIAGONAL],
    visibleEdgeLines: () => [DIAGONAL_LINE],
    projectToScreen: () => ({ x: 100, y: 100 }),
    pixelWorldSize: () => 1,
  } as unknown as Viewport;

  const tool = new EdgeFeatureTool(viewport, store);
  tool.start("fillet", () => {});
  return { tool };
}

describe("fillet/chamfer pre-selection CREATE entry picks an edge-aware drag axis", () => {
  it("a diagonal pre-selected edge does not leave the axis on the camera-right fallback", () => {
    const h = harness();
    const axis = (h.tool as unknown as { axis: THREE.Vector3 }).axis;
    const tangent = (h.tool as unknown as { tangent: THREE.Vector3 | null }).tangent;
    expect(tangent, "the pre-selection path should recompute a real tangent from the picked edge").not.toBeNull();
    expect(
      axis.distanceTo(new THREE.Vector3(1, 0, 0)) > 0.01,
      `axis should differ from the camera-right fallback (1,0,0) — got [${axis.x}, ${axis.y}, ${axis.z}]`,
    ).toBe(true);
  });
});
