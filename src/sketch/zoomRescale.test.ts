// Reports cf780621, 120226bc and 02ed8057: dimension arrowheads and endpoint
// dots grow and shrink with the zoom, then snap back to size at the next click.
// Both are sized in PIXELS (6 px arrowheads, ~5 px dots) but drawn in plane
// mm, and the mm-per-pixel they were drawn at was only refreshed by
// refreshActive, i.e. by an edit or a selection change. A zoom rescaled the grid
// and nothing else. arrowheadSize.test.ts sets the scale by hand, so it never
// saw a zoom.
//
// This drives the real enter() (which registers the per-frame zoom hook), the
// real refreshActive() (the bake) and then the hook exactly as the viewport's
// render loop calls it, and measures what was handed to the overlay to draw.
// Same stand-in harness as emptySketchNotCommitted.test.ts: SketchMode needs
// WebGL, so `this` is hand-built, but the methods under test are the real ones.
import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { SketchMode } from "./sketchMode";
import { SketchPlane } from "./plane";
import { setDimPixelScale } from "./entityDims";
import type { CadDocument, PlaneDef, SketchConstraint } from "../types";

const PLANE: PlaneDef = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };

(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener() {},
  removeEventListener() {},
};
(globalThis as unknown as { document: unknown }).document ??= {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

type ZoomHook = (wpp: number, tx: number, ty: number, tz: number) => void;

function makeSketch() {
  const view = { mmPerPx: 0.1, drawn: [] as THREE.Object3D[], draws: 0 };
  const viewport = {
    suspendPicking: false,
    enterSketchView() {},
    exitSketchView() {},
    hoverEntity() {},
    requestRender() {},
    rig: { setOrbitLocked() {} },
    domElement: { addEventListener() {}, removeEventListener() {} },
    onZoomScale: null as ZoomHook | null,
    pixelWorldSize: () => view.mmPerPx,
  };
  const s = Object.create(SketchMode.prototype) as SketchMode & Record<string, unknown>;
  Object.assign(s, {
    fonts: ["stub"],
    entities: [],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    pendingBindings: new Map<string, unknown>(),
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    dimPicks: [],
    dimsVisible: true,
    glyphsVisible: false,
    history: { reset() {} },
    patternFlow: { resetForEnter() {}, flushOnFinish() {}, pending: () => null },
    overlay: {
      planeFor: (spec: PlaneDef | string) => new SketchPlane(spec as PlaneDef),
      clearRegionSelection() {},
      update() {},
      setActiveSketch(objs: THREE.Object3D[]) {
        view.drawn = objs;
        view.draws++;
      },
      setActiveRegions() {},
      setPreview() {},
      setSnap() {},
    },
    viewport,
    dim: { hide() {} },
    dims: { hide() {}, show() {}, follow: () => true },
    glyphs: { hide() {} },
    textPanel: { hide() {} },
    projectPanel: { hide() {} },
    constraintTools: { resetPending() {} },
    // prototype methods that touch three.js / the solver, stubbed as own props
    addGrid() {},
    removeGrid() {},
    armPreEdit() {},
    setTool() {},
    setViewLocked() {},
    requestSolve() {},
    resetDimPicks() {},
    redrawGlyphs() {},
    showConstruction() {},
    drainBindings: () => undefined,
    viewLocked: false,
  });
  const doc: CadDocument = { version: 5, parameters: {}, features: [] };
  const store = { document: doc, nextId: () => "s1", addFeature() {}, replaceFeature() {}, updateFeature() {} };
  s.enter(PLANE, store as never);
  // a 20 mm line and an arc held at diameter 10: endpoint dots and a
  // dimension with arrowheads, drawn by the edit that put them there
  const ents = s as unknown as { entities: unknown[]; constraints: SketchConstraint[] };
  ents.entities.push(
    { type: "line", id: "l1", x1: 0, y1: 0, x2: 20, y2: 0 },
    { type: "arc", id: "a1", x1: 55, y1: 0, x2: 45, y2: 0, mx: 50, my: 5 },
  );
  ents.constraints.push({ type: "diameter", circle: "a1", value: 10 } as SketchConstraint);
  s.redraw(); // refreshActive: the bake, at view.mmPerPx
  /** One rendered frame at the current zoom, as viewport.ts's loop calls it. */
  const frame = () => viewport.onZoomScale?.(view.mmPerPx, 0, 0, 0);
  return { s, view, frame };
}

/** Half-width (plane mm) of the endpoint dots in what was last drawn: the
 *  5-point squares at renderOrder 14 (overlay.ts endpointDot). */
function dotHalfWidth(drawn: THREE.Object3D[]): number {
  const dots = drawn.filter((o) => o.renderOrder === 14 && o instanceof THREE.Line);
  expect(dots.length).toBeGreaterThan(0);
  const box = new THREE.Box3().setFromObject(dots[0]!);
  return (box.max.x - box.min.x) / 2;
}

/** Arrowhead length (plane mm) of the diameter dimension last drawn: tip to
 *  the midpoint of the two barbs (entityDims.diameterDim lines 1 and 2). */
function arrowLength(s: SketchMode): number {
  const cdims = (s as unknown as { cdims: { lines: [THREE.Vector2, THREE.Vector2][] }[] }).cdims;
  expect(cdims).toHaveLength(1);
  const [a, b] = [cdims[0]!.lines[1]!, cdims[0]!.lines[2]!];
  return a[0].distanceTo(a[1].clone().add(b[1]).multiplyScalar(0.5));
}

describe("cf780621: arrowheads and endpoint dots hold their screen size through a zoom", () => {
  beforeEach(() => setDimPixelScale(0));

  it("drawn at the zoom of the last edit: 6 px arrows, 2.5 px dot half-width", () => {
    const { s, view } = makeSketch();
    expect(arrowLength(s) / view.mmPerPx).toBeCloseTo(6, 6);
    expect(dotHalfWidth(view.drawn) / view.mmPerPx).toBeCloseTo(2.5, 6);
  });

  it("zooming IN 4x with no edit redraws them at the new zoom, not 4x bigger", () => {
    const { s, view, frame } = makeSketch();
    view.mmPerPx = 0.025;
    frame();
    expect(arrowLength(s) / view.mmPerPx).toBeCloseTo(6, 6); // was 24 px
    expect(dotHalfWidth(view.drawn) / view.mmPerPx).toBeCloseTo(2.5, 6); // was 10 px
  });

  it("zooming OUT 4x with no edit keeps them from going tiny", () => {
    const { s, view, frame } = makeSketch();
    view.mmPerPx = 0.4;
    frame();
    expect(arrowLength(s) / view.mmPerPx).toBeCloseTo(6, 6); // was 1.5 px
    expect(dotHalfWidth(view.drawn) / view.mmPerPx).toBeCloseTo(2.5, 6);
  });

  it("a frame that has barely zoomed redraws nothing (a big sketch stays smooth)", () => {
    const { view, frame } = makeSketch();
    const before = view.draws;
    frame(); // no zoom at all: a pan, an orbit step, a hover repaint
    view.mmPerPx *= 1.05; // a sliver of a wheel notch
    frame();
    expect(view.draws).toBe(before);
    view.mmPerPx *= 1.2; // a whole notch past the bake
    frame();
    expect(view.draws).toBe(before + 1);
  });
});
