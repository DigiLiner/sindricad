// Where the perspective camera spends its depth precision.
//
// Field case, 2026-10 (Doug's miter gauge STEP, Linux AppImage): "squiggles",
// stair-stepped runs along the back edge and around a slot, hidden edges
// bleeding through the rim. The mesh was sub-pixel accurate; the cause was the
// depth buffer. The camera had a FIXED near of 0.1 mm and far of 10 m, and a
// perspective depth buffer resolves roughly d^2 / (near * 2^bits) at distance
// d, so with a 16-bit buffer two surfaces 0.5 mm apart at 265 mm away land on
// the same depth value. WebGL only guarantees 16 bits. Rendered with an
// emulated 16-bit buffer at his angle, 7,760 pixels differed from the 24-bit
// render; a near plane at half the camera's distance from the model took that
// to 37.
//
// The rule: near follows the distance from the camera to the nearest thing
// drawn, but never so far out that it cuts into anything drawn. These tests
// pin the second half as hard as the first, because a clipped model is a far
// worse bug than squiggles.
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import {
  PERSP_FAR_MIN,
  PERSP_NEAR_MIN,
  addBoxSpan,
  addSceneSpan,
  emptySpan,
  perspDepthRange,
  drawnBoxes,
} from "./depthRange";

const FOV = 45;

/** The view-space depth of `p` for a camera at `eye` looking at `target`. */
function viewDepth(eye: THREE.Vector3, target: THREE.Vector3, p: THREE.Vector3): number {
  const fwd = target.clone().sub(eye).normalize();
  return p.clone().sub(eye).dot(fwd);
}

function spanOf(eye: THREE.Vector3, ...boxes: THREE.Box3[]) {
  const span = emptySpan();
  for (const b of boxes) addBoxSpan(b, eye, span);
  return span;
}

const box = (min: [number, number, number], max: [number, number, number]) =>
  new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));

describe("the perspective near and far planes", () => {
  it("pull near out to the model when the camera stands back from it", () => {
    // Doug's view, roughly: a ~160 mm part, the camera ~265 mm from its centre.
    const part = box([-80, -30, 0], [80, 30, 25]);
    const eye = new THREE.Vector3(150, -150, 160);
    const gap = part.distanceToPoint(eye);
    const { near, far } = perspDepthRange(spanOf(eye, part), FOV, 1400 / 900);
    // A thousand times the precision of the fixed 0.1 mm is the point.
    expect(near).toBeGreaterThan(gap * 0.25);
    expect(near).toBeGreaterThan(100 * PERSP_NEAR_MIN);
    // ...and still in front of every point of the part.
    expect(near).toBeLessThan(gap);
    expect(far).toBeGreaterThanOrEqual(PERSP_FAR_MIN);
  });

  it("keeps the old 0.1 mm when the camera is inside the model's box", () => {
    // Orbit pivot inside a part, or zoomed in on a feature: the nearest drawn
    // surface can be any distance away, so nothing larger is safe.
    const part = box([-50, -50, -50], [50, 50, 50]);
    const eye = new THREE.Vector3(1, 2, 3);
    expect(perspDepthRange(spanOf(eye, part), FOV, 1.5).near).toBe(PERSP_NEAR_MIN);
  });

  it("keeps the old range when nothing is drawn", () => {
    expect(perspDepthRange(emptySpan(), FOV, 1.5)).toEqual({ near: PERSP_NEAR_MIN, far: PERSP_FAR_MIN });
  });

  it("stays small when the camera grazes something", () => {
    // The ground grid seen from 2 mm above its plane: its near part is right
    // under the camera, so near must stay below 2 mm whatever the model does.
    const grid = box([-3000, -3000, 0], [3000, 3000, 0]);
    const part = box([-10, -10, 0], [10, 10, 20]);
    const eye = new THREE.Vector3(0, -400, 2);
    const { near } = perspDepthRange(spanOf(eye, part, grid), FOV, 1.5);
    expect(near).toBeLessThan(2);
    expect(near).toBeGreaterThanOrEqual(PERSP_NEAR_MIN);
  });

  it("scales with a huge model, and far reaches past all of it", () => {
    // A 30 m assembly framed from 60 m: the old fixed far of 10 m drew none of it.
    const big = box([-15000, -15000, 0], [15000, 15000, 5000]);
    const eye = new THREE.Vector3(40000, -40000, 30000);
    const span = spanOf(eye, big);
    const { near, far } = perspDepthRange(span, FOV, 1.5);
    expect(near).toBeGreaterThan(1000);
    expect(far).toBeGreaterThan(span.farthest);
    expect(near).toBeLessThan(far);
  });

  it("never goes below 0.1 mm for a tiny model seen from close up", () => {
    const tiny = box([0, 0, 0], [0.05, 0.05, 0.05]);
    const eye = new THREE.Vector3(0.1, 0.1, 0.1); // 0.09 mm off its corner
    const { near } = perspDepthRange(spanOf(eye, tiny), FOV, 1.5);
    expect(near).toBe(PERSP_NEAR_MIN);
  });

  it("never clips a point that is on screen, at any aspect ratio", () => {
    // The guarantee: whatever the content, near sits in front of every point
    // of it that the frustum can show. The worst point is in a frustum CORNER,
    // where view depth is smallest for its distance, so an ultra-wide window
    // is the hard case. Seeded so a failure reproduces.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const aspect of [0.25, 1, 16 / 9, 3, 6]) {
      const cam = new THREE.PerspectiveCamera(FOV, aspect, 1, 1e6);
      cam.position.set(0, 0, 0);
      cam.lookAt(0, 0, -1);
      cam.updateMatrixWorld();
      for (let i = 0; i < 2000; i++) {
        // a point at a random NDC position (corners included) and depth
        const ndc = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, 0.5);
        const dir = ndc.unproject(cam).normalize();
        const p = dir.multiplyScalar(1 + rnd() * 5000);
        // the tightest box around it is the point itself
        const span = spanOf(cam.position, new THREE.Box3(p.clone(), p.clone()));
        const { near, far } = perspDepthRange(span, FOV, aspect);
        const depth = viewDepth(cam.position, new THREE.Vector3(0, 0, -1), p);
        expect(near, `aspect ${aspect}, depth ${depth}`).toBeLessThanOrEqual(depth);
        expect(far).toBeGreaterThan(depth);
      }
    }
  });

  it("moves in steps, so a static or slowly moving view does not rebuild the projection", () => {
    const part = box([-10, -10, -10], [10, 10, 10]);
    const a = perspDepthRange(spanOf(new THREE.Vector3(0, 0, 200), part), FOV, 1.5);
    const b = perspDepthRange(spanOf(new THREE.Vector3(0, 0, 201), part), FOV, 1.5);
    expect(b).toEqual(a);
  });

  it("falls back to the old range for a non-finite span", () => {
    expect(perspDepthRange({ nearest: NaN, farthest: NaN }, FOV, 1.5)).toEqual({ near: PERSP_NEAR_MIN, far: PERSP_FAR_MIN });
  });
});

describe("what counts as drawn", () => {
  function mesh(at: [number, number, number], size = 2): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size));
    m.position.set(...at);
    return m;
  }

  it("measures every visible object where it is placed", () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.position.set(0, 0, 100); // a sketch plane's transform, say
    group.add(mesh([0, 0, 0]));
    scene.add(group);
    scene.add(mesh([0, 0, 500]));
    scene.updateMatrixWorld();
    const span = emptySpan();
    addSceneSpan(scene, new THREE.Vector3(0, 0, 0), span);
    expect(span.nearest).toBeCloseTo(99, 6);
    expect(span.farthest).toBeGreaterThan(500);
  });

  it("ignores hidden objects and the skipped subtree, but not lights or empty groups", () => {
    const scene = new THREE.Scene();
    const hidden = mesh([0, 0, 5]);
    hidden.visible = false;
    const hiddenParent = new THREE.Group();
    hiddenParent.visible = false;
    hiddenParent.add(mesh([0, 0, 6]));
    const skipped = new THREE.Group();
    skipped.add(mesh([0, 0, 7]));
    scene.add(hidden, hiddenParent, skipped, new THREE.DirectionalLight(), new THREE.Group(), mesh([0, 0, 50]));
    scene.updateMatrixWorld();
    const span = emptySpan();
    addSceneSpan(scene, new THREE.Vector3(0, 0, 0), span, skipped);
    expect(span.nearest).toBeCloseTo(49, 6);
  });

  it("ignores an object without vertices or with a junk box", () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry()));
    const junk = new THREE.Mesh(new THREE.BufferGeometry());
    junk.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1e100, -1e100, -1e100), new THREE.Vector3(1e100, 1e100, 1e100));
    scene.add(junk);
    scene.updateMatrixWorld();
    const span = emptySpan();
    addSceneSpan(scene, new THREE.Vector3(0, 0, 0), span);
    expect(span).toEqual(emptySpan());
  });

  it("keeps each object's box, so a camera between two bodies is outside both", () => {
    const g = new THREE.Group();
    g.add(mesh([20, 0, 0]), mesh([-20, 0, 0]));
    const off = mesh([0, 0, 900]);
    off.visible = false;
    g.add(off);
    g.updateMatrixWorld();
    const boxes = drawnBoxes(g);
    expect(boxes).toHaveLength(2);
    const span = emptySpan();
    for (const b of boxes) addBoxSpan(b, new THREE.Vector3(0, 0, 0), span);
    expect(span.nearest).toBeCloseTo(19, 6); // the union would have said 0
  });
});
